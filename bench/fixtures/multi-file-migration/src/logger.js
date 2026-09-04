// The structured logger every module should be using.
//
// Records are { level, fields, message } — the fields object carries the
// values that used to be interpolated into a format string.

const sinks = new Set();

/** Subscribe to log records. Returns an unsubscribe function. */
export function onLog(fn) {
  sinks.add(fn);
  return () => sinks.delete(fn);
}

function emit(level, fields, message) {
  for (const sink of sinks) sink({ level, fields, message });
}

export const logger = {
  debug: (fields, message) => emit('debug', fields, message),
  info: (fields, message) => emit('info', fields, message),
  warn: (fields, message) => emit('warn', fields, message),
  error: (fields, message) => emit('error', fields, message),
};
