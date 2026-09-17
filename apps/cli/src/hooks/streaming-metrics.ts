import type { ActivityMetrics } from '../view/ActivityStatus.js';

/** Display-only estimates; never enter usage accounting or cost calculations. */
export class StreamingMetrics {
  /**
   * The activity row is a status line, not an animation. Repainting it costs a
   * full-screen Ink diff whether or not the stream itself is being rendered, so
   * a chunk that lands within this window of the last push is counted and held
   * back — 5 Hz still reads as live.
   */
  private static readonly REFRESH_MS = 200;
  private chars = 0;
  private firstChars = 0;
  private firstAt?: number;
  private lastAt = 0;
  private pushedAt?: number;
  private reported: ActivityMetrics = {};
  private final = false;

  reset(): void {
    this.chars = this.firstChars = this.lastAt = 0;
    this.firstAt = this.pushedAt = undefined;
    this.reported = {};
    this.final = false;
  }

  /** `undefined` when the chunk counted but is not worth a repaint yet. */
  append(text: string, now = Date.now()): ActivityMetrics | undefined {
    this.chars += text.length;
    if (text.length && this.firstAt === undefined) {
      this.firstAt = now;
      this.firstChars = this.chars;
    }
    this.lastAt = now;
    if (this.pushedAt !== undefined && now - this.pushedAt < StreamingMetrics.REFRESH_MS) return undefined;
    this.pushedAt = now;
    return this.snapshot();
  }

  report(metrics: ActivityMetrics, final: boolean): ActivityMetrics {
    this.reported = metrics;
    this.final = final;
    return this.snapshot();
  }

  private snapshot(): ActivityMetrics {
    if (this.final || !this.chars) return this.reported;
    // Providers often report only completed requests, even while the next one
    // streams. Do not let repeated stale samples erase the live estimate.
    const estimate = Math.ceil(this.chars / 4);
    const estimated = estimate > (this.reported.outputTokens ?? 0);
    const elapsed = this.lastAt - (this.firstAt ?? this.lastAt);
    // The rate has to describe the count standing next to it. Once the provider's
    // own number is the one on screen, a rate derived from streamed characters is
    // measuring something else — a different quantity over a wall clock that also
    // spans tool and approval waits — so the provider's rate stays.
    const output = estimated && elapsed >= 250
      ? (this.chars - this.firstChars) / 4 / (elapsed / 1000)
      : undefined;
    return {
      ...this.reported,
      outputTokens: Math.max(estimate, this.reported.outputTokens ?? 0),
      outputTokensApproximate: estimated,
      rates: { ...this.reported.rates, output: output ?? this.reported.rates?.output },
    };
  }
}
