/**
 * An error rendered for a model rather than for a log.
 *
 * A tool returns its failures as strings, so a thrown value has to become one
 * without dragging a stack trace into the model's context. `String(err)` alone
 * gives `[object Object]` for anything that is not an Error, which tells the
 * caller nothing at all.
 */
export function safe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
