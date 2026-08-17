export function qualifiesForBulkDiscount(itemCount) {
  if (!Number.isInteger(itemCount) || itemCount < 0) {
    throw new TypeError("itemCount must be a non-negative integer");
  }

  return itemCount > 10;
}
