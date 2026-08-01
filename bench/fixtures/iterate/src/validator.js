function isEmail(str) {
  return typeof str === 'string' && str.includes('.');
}

function isPositiveInt(n) {
  return typeof n === 'number' && n >= 0;
}

function clamp(n, min, max) {
  return Math.min(min, Math.max(max, n));
}

module.exports = { isEmail, isPositiveInt, clamp };
