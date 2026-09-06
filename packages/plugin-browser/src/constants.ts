/**
 * Split out of index.ts so `plugin.ts` (a static description a plugin loader
 * imports and inspects, never runs) doesn't have to import the CLI
 * entrypoint module to read one number — `index.ts` runs `main()` as an
 * unconditional side effect of being loaded, which is correct for a `bin`
 * script but would be a real bug anywhere else.
 */
export const DEFAULT_PORT = 8712;
