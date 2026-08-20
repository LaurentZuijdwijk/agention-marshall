import { History } from '@agentionai/agents/core';
import type { ReducibleEntry } from '@agentionai/agents/core';

/**
 * A History that can be rewritten in place without losing entry metadata.
 *
 * The session's repair paths — dropping an orphaned tool result, popping a
 * rejected request's tail, pairing a cancelled call with a result — all need to
 * rebuild history from a modified copy of itself. The obvious way to do that,
 * `entries` → `clear()` → `addEntry()`, silently destroys metadata: the public
 * `entries` getter strips `__metadata` (it is documented as being for
 * serialization), and `addEntry` builds a *fresh* one and spreads it last, so
 * anything the caller carried in is overwritten. What is lost is `isSummary`
 * and `coversRange`, which is exactly what `middleCompressionPlugin` reads to
 * recognise a summary it has already made — so a session that repaired itself
 * once would then re-summarise its own summary as if it were an ordinary turn,
 * and every entry's `date` would read as the moment of the repair.
 *
 * `_entries` is `protected`, so a subclass is the supported way to reach the
 * metadata-carrying entries. Assigning to it also deliberately skips the
 * `addEntry` side effects — `applyTrimming`, the `entry` event, and the
 * `afterAdd` plugin hooks. That is what we want here: re-adding N entries one
 * at a time would fire N `afterAdd` hooks, and the compression plugin's hook
 * kicks off a reduce.
 */
export class SessionHistory extends History {
  /**
   * Entries as stored, metadata included. A copy — callers rebuild from this
   * and hand the result back to `replaceEntries`.
   */
  get rawEntries(): ReducibleEntry[] {
    return [...this._entries];
  }

  /**
   * Replace history wholesale, keeping whatever metadata each entry carries.
   *
   * Entries whose content shrank keep the `contentLength` and `estimatedTokens`
   * they were measured with, so the token estimate can run slightly high until
   * the next compression recomputes it. That is the safe direction to be wrong
   * in — it compresses marginally early rather than marginally late — and the
   * alternative is re-deriving an estimate with a function the library does not
   * export.
   */
  replaceEntries(entries: readonly ReducibleEntry[]): void {
    this._entries = [...entries];
  }
}
