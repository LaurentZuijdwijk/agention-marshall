import { parseOpenRouterModels } from '@agentionai/marshall-engine';
import type { PriceBook } from '@agentionai/marshall-engine';

/**
 * Model prices, so token counts can be reported in money.
 *
 * OpenRouter only, because OpenRouter is the only provider we already talk to
 * that publishes machine-readable prices without a key. The alternative is a
 * hand-maintained table of everyone else's rates, which is a table that goes
 * stale silently and then misreports what a session cost — a wrong number about
 * money is worse than no number, so the other providers show tokens alone.
 *
 * Self-hosted models are priced at zero by the engine (see `pricingFor`), which
 * is why a llama.cpp fast tier alongside an OpenRouter deep tier still totals
 * exactly rather than reporting a floor.
 */
export async function fetchOpenRouterPricing(signal?: AbortSignal): Promise<PriceBook> {
  const prices = new Map<string, { prompt: number; completion: number }>();
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', { signal });
    if (!response.ok) return prices;
    for (const model of parseOpenRouterModels(await response.json())) {
      if (model.pricing) prices.set(model.id, model.pricing);
    }
  } catch {
    // Offline, rate-limited, or the shape changed. Cost is a nicety on top of
    // the token counts, so it fails to nothing rather than to an error row.
  }
  return prices;
}
