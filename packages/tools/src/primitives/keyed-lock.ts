/**
 * Serialise async work per key.
 *
 * Exists because the mutating file tools are read-modify-write across an
 * `await`, and models routinely emit several tool calls in one assistant
 * message which the agent SDK then runs concurrently. Two `edit_file` calls on
 * one path both read the same original, each computes its replacement from it,
 * and the second write silently drops the first edit — while both report
 * success. `atomicWrite` does not help: each individual write is atomic, it is
 * the read-then-write pair that is not.
 *
 * Keyed rather than global so edits to *different* files still run in parallel,
 * which is the case the model is actually optimising for when it batches calls.
 */

export type KeyedLock = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

export function createKeyedLock(): KeyedLock {
  /** Per key: a promise for "everything queued so far has settled". */
  const tails = new Map<string, Promise<void>>();

  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    // Defer fn to a microtask so it never runs synchronously — prevents two
    // concurrent calls from both reading a resolved prev and executing fn in
    // parallel.
    const result = prev.then(() => Promise.resolve().then(fn));

    // The tail swallows rejection deliberately: one failed operation must not
    // wedge everything queued behind it on the same key. Callers still get the
    // real `result`, rejection and all.
    const tail = result.then(() => {}, () => {});
    tails.set(key, tail);
    // Drop the entry once the queue for this key has drained, so a long session
    // touching many files does not retain a promise per path forever. Guarded
    // by the identity check: anything that queued up in the meantime replaced
    // `tail`, and that queue must not be discarded.
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });

    return result;
  };
}
