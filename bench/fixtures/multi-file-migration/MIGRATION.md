# Logging migration

Every module under `src/` still calls the deprecated `log()` from
`src/legacy-log.js`. Migrate them all to the structured logger in
`src/logger.js`, then delete `src/legacy-log.js`.

## The rule

A legacy call:

```js
log(ctx, 'WARN', 'retry %s of %s for %s', attempt, max, url);
```

becomes:

```js
logger.warn({ attempt, max, url }, 'retry');
```

Specifically:

1. **Level** — the `'WARN'` string becomes the method name, lowercased:
   `logger.warn(...)`. Levels in use are DEBUG, INFO, WARN, ERROR.
2. **Message** — everything in the template *before the first `%s`*, trimmed.
   `'retry %s of %s for %s'` gives `'retry'`. A template with no `%s` is
   used whole: `'started'` gives `'started'`.
3. **Fields** — one entry per remaining argument, in order. The key is the
   argument expression, or its **last dotted segment** if it has one:
   - `attempt` gives `attempt`
   - `job.name` gives `name: job.name`
   A call with no arguments gets an empty object: `logger.info({}, 'started')`.
4. Replace the `import { log } from './legacy-log.js'` line with
   `import { logger } from './logger.js'`, and drop the now-unused
   `const ctx = ...` line.

## Out of scope

- `src/vendor/` is vendored third-party code with its own unrelated `log`
  function. Leave it exactly as it is.
- Some modules have already been migrated. Leave those alone too.

## Done when

`node --test` passes and `src/legacy-log.js` is gone.
