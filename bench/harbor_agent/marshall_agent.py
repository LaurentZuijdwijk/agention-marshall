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

# Module-level, not per-instance: Harbor runs several trials concurrently
# within one process (--n-concurrent, default 4), each with its own
# MarshallAgent instance, and every one of them would otherwise race to
# `npm pack` the same checkout into the same dist/ output. Built once, shared
# by whichever instance asks first.
_pack_lock = asyncio.Lock()
_cached_tarball: Path | None = None


class MarshallAgent(BaseInstalledAgent):
    """Runs marshall — a terminal coding agent — via its `--message` headless mode."""

    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)

    @staticmethod
    @override
    def name() -> str:
        return "marshall"

    @staticmethod
    def _build_and_pack() -> Path:
        """`npm pack` this checkout's apps/cli into a fresh temp dir, built first.

        Blocking — always called through `_pack_local_cli`, which keeps it off
        the event loop and runs it at most once per process.
        @agentionai/marshall-engine and -tools aren't touched here: their
        published versions already match this checkout (see the module
        docstring), so the packed tarball's `"*"` dependency on them resolves
        from the registry as normal.
        """
        subprocess.run(
            ["npm", "run", "build:all"], cwd=_REPO_ROOT, check=True, capture_output=True, text=True,
        )
        pack_dir = Path(tempfile.mkdtemp(prefix="marshall-cli-pack-"))
        result = subprocess.run(
            ["npm", "pack", "--pack-destination", str(pack_dir)],
            cwd=_REPO_ROOT / "apps" / "cli", check=True, capture_output=True, text=True,
        )
        tarball_name = result.stdout.strip().splitlines()[-1]
        return pack_dir / tarball_name

    async def _pack_local_cli(self) -> Path:
        """The build+pack, done at most once per process and shared.

        The lock alone would only stop two builds from *overlapping* — the
        actual `subprocess.run` calls are synchronous and would otherwise
        block the single event loop for the whole build, stalling every other
        concurrent trial's install too. `asyncio.to_thread` keeps that off
        the loop; the lock is what stops it from running twice.
        """
        global _cached_tarball
        async with _pack_lock:
            if _cached_tarball is None or not _cached_tarball.exists():
                _cached_tarball = await asyncio.to_thread(self._build_and_pack)
            return _cached_tarball

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl",))
        local_tarball = await self._pack_local_cli()
        remote_tarball = "/tmp/marshall-cli.tgz"
        await environment.upload_file(local_tarball, remote_tarball)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"npm install -g {remote_tarball} && "
                "marshall --version"
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
        harbor_provider, model = self.model_name.split("/", 1)
        provider = _PROVIDER_TO_MARSHALL.get(harbor_provider, harbor_provider)

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
        context.cost_usd = session.get("costUsd")
        # No first-class AgentContext field for it — reasoningTokens is a
        # subset of outputTokens (billed as output either way), so it only
        # belongs in metadata, not counted again on top of n_output_tokens.
        reasoning_tokens = session.get("reasoningTokens")
        if reasoning_tokens:
            context.metadata = {**(context.metadata or {}), "reasoning_tokens": reasoning_tokens}
