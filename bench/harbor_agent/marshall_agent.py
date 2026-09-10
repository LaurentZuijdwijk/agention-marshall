"""Harbor agent adapter for marshall.

Wraps marshall-cli's headless mode (`--safety yolo --message <task>`) the same
way Harbor's own reference agents (aider.py, qwen_code.py) wrap theirs:
install, run one instruction to completion, exit. See apps/cli's
`startup/headless.ts` for what that mode actually does.

`--message`/`--safety` are unreleased — not yet in the published
@agentionai/marshall-cli on npm — so `install()` packs *this* checkout with
`npm pack` and installs that tarball in the container, rather than pulling
from the registry. Switch back to a plain `npm install -g` once a release
ships them (see @agentionai/marshall-engine and -tools, which install()
still takes from the registry unmodified — only apps/cli has local changes).

Usage, from the repo root:

    pip install harbor
    PYTHONPATH=bench harbor run -d "<dataset>@<version>" \\
        --agent harbor_agent.marshall_agent:MarshallAgent \\
        --model anthropic/claude-sonnet-4-6
"""

import asyncio
import json
import shlex
import subprocess
import tempfile
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

_REPO_ROOT = Path(__file__).resolve().parents[2]

# Harbor infers a provider slug from the `provider/model` half of --model and,
# with `passthrough=True`, forwards that provider's canonical API-key env var
# unchanged. marshall reads the same env vars under its own --provider names
# (PROVIDER_DEFAULTS in apps/cli/src/startup/args.ts), which match everywhere
# except these two.
_PROVIDER_TO_MARSHALL = {
    "anthropic": "claude",
    "google": "gemini",
}

# marshall authenticates `codex` and `claude` from an OAuth login on disk, not
# from an env var — PROVIDER_DEFAULTS gives both `envKey: null` — so a key
# passed through model_connection cannot reach them. Harbor's own Codex agent
# has the same problem and solves it the same way: upload the host's credential
# file into the container (see codex.py's CODEX_AUTH_JSON_PATH /
# CODEX_FORCE_AUTH_JSON). Ours is ~/.marshall/credentials.json, written by
# `/login codex` or by adopting an existing `codex login`; the file's shape and
# location are owned by packages/engine/src/oauth-store.ts.
_OAUTH_PROVIDERS = frozenset({"codex", "claude"})
_REMOTE_CREDENTIALS = "/tmp/marshall-credentials.json"


def _marshall_provider(model_name: str | None) -> str | None:
    """The marshall `--provider` name a Harbor `provider/model` string implies."""
    if not model_name or "/" not in model_name:
        return None
    harbor_provider = model_name.split("/", 1)[0]
    return _PROVIDER_TO_MARSHALL.get(harbor_provider, harbor_provider)


# Module-level, not per-instance: Harbor runs several trials concurrently
# within one process (--n-concurrent, default 4), each with its own
# MarshallAgent instance, and every one of them would otherwise race to
# `npm pack` the same checkout into the same dist/ output. Built once, shared
# by whichever instance asks first.
_pack_lock = asyncio.Lock()
_cached_tarballs: list[Path] | None = None


class MarshallAgent(BaseInstalledAgent):
    """Runs marshall — a terminal coding agent — via its `--message` headless mode."""

    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)

    @staticmethod
    @override
    def name() -> str:
        return "marshall"

    @staticmethod
    def _build_and_pack() -> list[Path]:
        """`npm pack` this checkout's workspaces into a fresh temp dir, built first.

        Blocking — always called through `_pack_local_cli`, which keeps it off
        the event loop and runs it at most once per process.
        Packs the CLI *and* @agentionai/marshall-tools, -engine and
        -plugin-browser: the checkout's cli imports engine exports that the
        registry version of the same version number does not carry yet
        (seen 2026-09-10: `listCodexModels`), so the registry copies cannot be
        relied on to match. install() drops the workspace tarballs into the
        CLI's own node_modules. Order matters: dependencies first.
        """
        subprocess.run(
            ["npm", "run", "build:all"], cwd=_REPO_ROOT, check=True, capture_output=True, text=True,
        )
        pack_dir = Path(tempfile.mkdtemp(prefix="marshall-cli-pack-"))
        tarballs = []
        for ws in ("packages/tools", "packages/engine", "packages/plugin-browser", "apps/cli"):
            result = subprocess.run(
                ["npm", "pack", "--pack-destination", str(pack_dir)],
                cwd=_REPO_ROOT / ws, check=True, capture_output=True, text=True,
            )
            tarballs.append(pack_dir / result.stdout.strip().splitlines()[-1])
        return tarballs

    async def _pack_local_cli(self) -> list[Path]:
        """The build+pack, done at most once per process and shared.

        The lock alone would only stop two builds from *overlapping* — the
        actual `subprocess.run` calls are synchronous and would otherwise
        block the single event loop for the whole build, stalling every other
        concurrent trial's install too. `asyncio.to_thread` keeps that off
        the loop; the lock is what stops it from running twice.
        """
        global _cached_tarballs
        async with _pack_lock:
            if _cached_tarballs is None or not all(t.exists() for t in _cached_tarballs):
                _cached_tarballs = await asyncio.to_thread(self._build_and_pack)
            return _cached_tarballs

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl",))
        tarballs = await self._pack_local_cli()
        remote = []
        for t in tarballs:
            r = f"/tmp/{t.name}"
            await environment.upload_file(t, r)
            remote.append(r)
        cli_tgz, deps = remote[-1], remote[:-1]
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"npm install -g {cli_tgz} && "
                # replace the registry copies of the workspace packages with this checkout's
                f"cd \"$(npm root -g)/@agentionai/marshall-cli\" && npm install {' '.join(deps)} && "
                "marshall --version"
            ),
        )
        await self._install_credentials(environment)

    async def _install_credentials(self, environment: BaseEnvironment) -> None:
        """Put this host's marshall OAuth login inside the container.

        Only for the providers that authenticate that way, and only when a
        login exists: every other provider takes an API key through the
        environment, and shipping a token file to one would hand a benchmark
        container a credential it has no use for.
        """
        if _marshall_provider(self.model_name) not in _OAUTH_PROVIDERS:
            return
        override = self._get_env("MARSHALL_CREDENTIALS_PATH")
        local = (
            Path(override) if override
            else Path.home() / ".marshall" / "credentials.json"
        )
        if not local.is_file():
            raise ValueError(
                f"--model {self.model_name} needs a marshall OAuth login, but "
                f"{local} does not exist. Sign in on this host first (`/login codex` "
                "adopts an existing `codex login`), or point --ae "
                "MARSHALL_CREDENTIALS_PATH=<path> at the file."
            )
        await environment.upload_file(local, _REMOTE_CREDENTIALS)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'mkdir -p "$HOME/.marshall" && '
                f'cp {_REMOTE_CREDENTIALS} "$HOME/.marshall/credentials.json" && '
                'chmod 600 "$HOME/.marshall/credentials.json"'
            ),
        )

    @override
    def get_version_command(self) -> str | None:
        # Called separately from install() (see BaseInstalledAgent.setup) —
        # this is what actually lands in the trial result's agent_info.version.
        return ". ~/.nvm/nvm.sh; marshall --version"

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError(
                "Model name must be in the format provider/model, "
                "e.g. anthropic/claude-sonnet-4-6"
            )
        provider = _marshall_provider(self.model_name)
        model = self.model_name.split("/", 1)[1]

        # Not every provider needs a key — llamacpp is host-only, and isn't
        # even in Harbor's own PROVIDERS registry, so model_connection.env is
        # legitimately empty for it. marshall reports its own clear error for
        # a provider that *does* need one and doesn't have it; no need to
        # duplicate that check here.
        env = dict(self.model_connection.env)

        # --ae/--agent-env MARSHALL_HOST=... on the harbor CLI — the one piece
        # a provider/model string can't carry: where a local server actually
        # is. Unused for a hosted provider, where marshall's own default is
        # already right.
        host = self._get_env("MARSHALL_HOST")
        host_flag = f"--host {shlex.quote(host)} " if host else ""

        await self.exec_as_agent(
            environment,
            command=(
                ". ~/.nvm/nvm.sh; "
                f"marshall --provider {shlex.quote(provider)} --model {shlex.quote(model)} "
                f"{host_flag}"
                f"--safety yolo --message {shlex.quote(instruction)} "
                "2>&1 | stdbuf -oL tee /logs/agent/marshall.txt"
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Read the `MARSHALL_USAGE` marker line `headless.ts` writes at turn end.

        `/logs/agent/marshall.txt` inside the container (the `tee` target in
        `run()`) is the same file as `self.logs_dir / "marshall.txt"` here on
        the host — Harbor bind-mounts the one into the other.
        """
        log_path = self.logs_dir / "marshall.txt"
        if not log_path.exists():
            return
        usage = None
        for line in log_path.read_text(errors="replace").splitlines():
            if line.startswith("MARSHALL_USAGE "):
                usage = json.loads(line.removeprefix("MARSHALL_USAGE "))
        if usage is None:
            return

        session = usage.get("session") or {}
        context.n_input_tokens = session.get("inputTokens")
        context.n_output_tokens = session.get("outputTokens")
        # A subset of inputTokens, which is also how Harbor's own agents report
        # it — codex.py sets n_cache_tokens from `cached_tokens` while leaving
        # n_input_tokens as the full prompt. Absent (rather than 0) whenever the
        # provider said nothing about caching, so a missing figure never reads
        # as "nothing was cached".
        context.n_cache_tokens = session.get("cacheReadTokens")
        # None on a ChatGPT subscription: that backend bills plan allowance, not
        # dollars, so there is no per-call cost to report.
        context.cost_usd = session.get("costUsd")
        extra: dict[str, object] = {}
        # No first-class AgentContext field for it — reasoningTokens is a
        # subset of outputTokens (billed as output either way), so it only
        # belongs in metadata, not counted again on top of n_output_tokens.
        reasoning_tokens = session.get("reasoningTokens")
        if reasoning_tokens:
            extra["reasoning_tokens"] = reasoning_tokens
        # Plan allowance rather than dollars — what a run on a ChatGPT
        # subscription actually spends, since cost_usd is undefined there. Sits
        # beside the token counts rather than in them: it is a level describing
        # the account, not a total describing this trial, so two trials' values
        # cannot be added and a later trial's reading supersedes an earlier one.
        quota = usage.get("quota")
        if quota:
            extra["quota"] = quota
        if extra:
            context.metadata = {**(context.metadata or {}), **extra}
