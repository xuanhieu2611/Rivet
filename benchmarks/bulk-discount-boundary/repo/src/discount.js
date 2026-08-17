export function qualifiesForBulkDiscount(quantity) {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new TypeError("quantity must be a non-negative integer");
  }

  return quantity > 10;
}
