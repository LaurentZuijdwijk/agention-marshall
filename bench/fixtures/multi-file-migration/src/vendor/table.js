// Vendored third-party helper — DO NOT MODIFY.
//
// This file has its own unrelated `log` function. It is not part of the
// migration and must be left exactly as it is.

function log(scope, message) {
  return `[${scope}] ${message}`;
}

export function render(scope, rows) {
  return rows.map((row, i) => log(scope, `row ${i}: ${row}`));
}
