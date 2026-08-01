const { getTotal } = require('./math');

function formatReceipt(items) {
  const total = getTotal(items);
  return `Total: $${total.toFixed(2)}`;
}

module.exports = { formatReceipt };
