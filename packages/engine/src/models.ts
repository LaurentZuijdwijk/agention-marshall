// ── local model discovery (pure parsing, testable) ────────────────────────────
//
// Local servers report far more than a list of names, and which fields exist
// depends on the server *and* on whether a given model is currently resident:
//
//   llama.cpp router  /v1/models  → per-model `status.value` (loaded/unloaded),
//                                   `status.failed`, and — only for loaded
//                                   models — a `meta` block with the real
//                                   runtime n_ctx, n_ctx_train, n_params, size
//                                   and ftype. Unloaded models still reveal the
//                                   context their preset will ask for, via
//                                   `--ctx-size` in status.args or `ctx-size =`
//                                   in status.preset.
//   llama.cpp single  /props      → not a router; the one served model is
//                                   loaded, and n_ctx is the live value.
//   ollama            /api/tags   → sizes and quantisation for every model,
//                     /api/ps     → which are resident, and their context.
//
// Every field is optional on purpose: a server we don't recognise degrades to
// a bare list of names rather than breaking the picker.

export interface ModelInfo {
  id: string;
  loaded?: boolean;
  /** The server tried to start this model and it exited non-zero. */
  failed?: boolean;
  context?: number;
  /**
   * `active` = the window the model is actually running with.
   * `configured` = what its preset will request once loaded.
   */
  contextSource?: 'active' | 'configured';
  /** Maximum the model was trained for — the ceiling on `context`. */
  contextTrain?: number;
  paramsLabel?: string;
  sizeBytes?: number;
  quant?: string;
  /** Input modalities beyond text — servers report `image`, `audio`, … */
  extraModalities?: string[];
  /** OpenRouter's per-token USD prices. */
  pricing?: { prompt: number; completion: number };
  /** OpenRouter's vendor-facing display name. */
  label?: string;
  maxOutput?: number;
  reasoning?: boolean;
  /** Whether the model advertises native tool-call support. */
  supportsTools?: boolean;
}

// ── formatting ────────────────────────────────────────────────────────────────

/**
 * Context windows are quoted in decimal thousands, not KiB — these numbers are
 * configured by hand (80000, 120000) and "117k" for 120000 would just confuse.
 */
export function formatContext(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatParams(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e9) return `${Number((n / 1e9).toFixed(n < 1e10 ? 1 : 0))}B`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
  return String(n);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

/** Format an OpenRouter per-token USD price as dollars per million tokens. */
export function formatPrice(perToken: number): string {
  if (!Number.isFinite(perToken) || perToken < 0) return '';
  if (perToken === 0) return 'free';
  const perMillion = perToken * 1_000_000;
  const digits = perMillion < 1 ? 2 : perMillion < 10 ? 2 : perMillion < 100 ? 1 : 0;
  return `$${perMillion.toFixed(digits).replace(/\.?0+$/, '')}/M`;
}

// ── llama.cpp ─────────────────────────────────────────────────────────────────

/** `--ctx-size 131072` / `-c 131072` in the launch arguments. */
function contextFromArgs(args: unknown): number | undefined {
  if (!Array.isArray(args)) return undefined;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--ctx-size' || args[i] === '-c') {
      const value = Number(args[i + 1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return undefined;
}

/** `ctx-size = 131072` in the preset block. */
function contextFromPreset(preset: unknown): number | undefined {
  if (typeof preset !== 'string') return undefined;
  const match = /^\s*ctx-size\s*=\s*(\d+)/m.exec(preset);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parseLlamaCppModels(payload: unknown): ModelInfo[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  const models: ModelInfo[] = [];
  for (const raw of data) {
    const entry = raw as Record<string, any>;
    if (typeof entry?.id !== 'string' || entry.id === '') continue;

    const status = (entry.status ?? {}) as Record<string, unknown>;
    const meta = (entry.meta ?? {}) as Record<string, unknown>;
    const info: ModelInfo = { id: entry.id };

    if (status.value === 'loaded') info.loaded = true;
    if (status.failed === true) info.failed = true;

    // A loaded model reports the window it is actually running with; an
    // unloaded one can only tell us what it intends to request.
    if (typeof meta.n_ctx === 'number' && meta.n_ctx > 0) {
      info.context = meta.n_ctx;
      info.contextSource = 'active';
    } else {
      const configured = contextFromArgs(status.args) ?? contextFromPreset(status.preset);
      if (configured !== undefined) {
        info.context = configured;
        info.contextSource = 'configured';
      }
    }

    if (typeof meta.n_ctx_train === 'number' && meta.n_ctx_train > 0) info.contextTrain = meta.n_ctx_train;
    if (typeof meta.n_params === 'number' && meta.n_params > 0) info.paramsLabel = formatParams(meta.n_params);
    if (typeof meta.size === 'number' && meta.size > 0) info.sizeBytes = meta.size;
    if (typeof meta.ftype === 'string' && meta.ftype !== '') info.quant = meta.ftype;

    const modalities = entry.architecture?.input_modalities;
    if (Array.isArray(modalities)) {
      const extra = modalities.filter((m: unknown) => typeof m === 'string' && m !== 'text');
      if (extra.length > 0) info.extraModalities = extra;
    }

    models.push(info);
  }
  return models;
}

/**
 * A non-router llama-server serves exactly one model, and it is by definition
 * loaded — `/v1/models` doesn't say so, but `/props` does.
 */
export function applyLlamaCppProps(models: ModelInfo[], props: unknown): ModelInfo[] {
  const p = props as Record<string, any> | null;
  if (!p || p.role === 'router') return models;

  const n = p.default_generation_settings?.n_ctx;
  if (typeof n !== 'number' || n <= 0) return models;

  return models.map(m => ({
    ...m,
    loaded: true,
    context: m.contextSource === 'active' ? m.context : n,
    contextSource: 'active' as const,
  }));
}

// ── ollama ────────────────────────────────────────────────────────────────────

export function parseOllamaModels(tags: unknown, running?: unknown): ModelInfo[] {
  const list = (tags as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];

  // /api/ps reports only the resident models, keyed by the same name.
  const resident = new Map<string, Record<string, any>>();
  const psList = (running as { models?: unknown })?.models;
  if (Array.isArray(psList)) {
    for (const raw of psList) {
      const entry = raw as Record<string, any>;
      if (typeof entry?.name === 'string') resident.set(entry.name, entry);
    }
  }

  const models: ModelInfo[] = [];
  for (const raw of list) {
    const entry = raw as Record<string, any>;
    if (typeof entry?.name !== 'string' || entry.name === '') continue;

    const info: ModelInfo = { id: entry.name };
    if (typeof entry.size === 'number' && entry.size > 0) info.sizeBytes = entry.size;

    const details = entry.details as Record<string, any> | undefined;
    if (typeof details?.parameter_size === 'string') info.paramsLabel = details.parameter_size;
    if (typeof details?.quantization_level === 'string') info.quant = details.quantization_level;
    // Ollama calls it a capability rather than a modality.
    if (Array.isArray(entry.capabilities) && entry.capabilities.includes('vision')) {
      info.extraModalities = ['image'];
    }

    const live = resident.get(entry.name);
    if (live) {
      info.loaded = true;
      if (typeof live.context_length === 'number' && live.context_length > 0) {
        info.context = live.context_length;
        info.contextSource = 'active';
      }
    }

    models.push(info);
  }
  return models;
}

// ── openrouter ────────────────────────────────────────────────────────────────

/**
 * Parse OpenRouter's /api/v1/models catalogue. No auth needed.
 *
 * The catalogue contains models for many modalities and capabilities. Keep
 * every text-only-output model; `supportsTools` records whether the model can
 * call tools so the picker can warn before selection.
 */
export function parseOpenRouterModels(payload: unknown, pinned: string[] = []): ModelInfo[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const raw of data) {
    const entry = raw as Record<string, any>;
    if (typeof entry?.id !== 'string' || entry.id === '') continue;
    const id: string = entry.id;
    if (seen.has(id)) continue; // :free variants share a canonical slug

    const supported: unknown[] = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
    const outputs: unknown[] = entry.architecture?.output_modalities ?? [];
    if (!outputs.includes('text') || outputs.some(o => o !== 'text')) continue;
    // Meta-routers price at -1 and just forward elsewhere.
    if (entry.pricing?.prompt === '-1') continue;
    seen.add(id);
    const info: ModelInfo = { id };
    if (typeof entry.context_length === 'number' && entry.context_length > 0) {
      info.context = entry.context_length;
      info.contextSource = 'configured';
    }
    const prompt = Number(entry.pricing?.prompt);
    const completion = Number(entry.pricing?.completion);
    if (Number.isFinite(prompt) && prompt >= 0 && Number.isFinite(completion) && completion >= 0) {
      info.pricing = { prompt, completion };
    }
    if (typeof entry.name === 'string' && entry.name !== '') info.label = entry.name;
    const maxOutput = entry.top_provider?.max_completion_tokens;
    if (typeof maxOutput === 'number' && maxOutput > 0) info.maxOutput = maxOutput;
    info.supportsTools = supported.includes('tools');
    if (entry.reasoning?.mandatory === true || entry.reasoning?.default_enabled === true) {
      info.reasoning = true;
    } else if (Array.isArray(supported) && supported.includes('reasoning')) {
      info.reasoning = true;
    }
    const inputs: unknown[] = entry.architecture?.input_modalities ?? [];
    const extra = inputs.filter((m): m is string => typeof m === 'string' && m !== 'text');
    if (extra.length > 0) info.extraModalities = extra;
    models.push(info);
  }

  // Presets first (they're the recommended defaults), then newest first —
  // `created` is a unix timestamp and freshest families matter most here.
  const pinnedSet = new Set(pinned);
  const withCreated = models.map(m => {
    const raw = (data as any[]).find(e => e?.id === m.id);
    const prompt = Number(raw?.pricing?.prompt);
    const completion = Number(raw?.pricing?.completion);
    return {
      m,
      created: typeof raw?.created === 'number' ? raw.created : 0,
      free: prompt === 0 && completion === 0,
    };
  });
  withCreated.sort((a, b) => {
    // Any zero-priced model first, including providers that do not use :free IDs.
    const aFree = a.free ? 1 : 0;
    const bFree = b.free ? 1 : 0;
    return bFree - aFree ||
      Number(pinnedSet.has(b.m.id)) - Number(pinnedSet.has(a.m.id)) ||
      b.created - a.created;
  });
  return withCreated.map(x => x.m);
}
