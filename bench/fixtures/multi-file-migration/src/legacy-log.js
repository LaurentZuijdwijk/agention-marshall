// Deprecated. Do not add new call sites; migrate existing ones to logger.js.

const history = [];

export function log(ctx, level, template, ...args) {
  let i = 0;
  const rendered = template.replace(/%s/g, () => String(args[i++]));
  history.push({ module: ctx?.module, level, rendered });
}

export function drain() {
  return history.splice(0, history.length);
}
