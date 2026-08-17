export const BULK_QUANTITY = 10;
export const BULK_DISCOUNT_PERCENT = 10;

function assertLine(line) {
  const { quantity, unitPriceCents } = line ?? {};
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new TypeError("quantity must be a non-negative integer");
  }
  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
    throw new TypeError("unitPriceCents must be a non-negative integer");
  }
}

/**
 * Returns the order total in whole cents.
 *
 * The bulk discount is not implemented yet: every line is charged at full
 * price. See the issue for the rule it has to follow.
 */
export function orderTotal(lines) {
  if (!Array.isArray(lines)) throw new TypeError("lines must be an array");

  let total = 0;
  for (const line of lines) {
    assertLine(line);
    total += line.quantity * line.unitPriceCents;
  }
  return total;
}
