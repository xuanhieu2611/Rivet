const BULK_THRESHOLD_CENTS = 10_000;
const BULK_DISCOUNT_BASIS_POINTS = 500;
const TAX_BASIS_POINTS = 825;

export function lineTotalCents(line) {
  assertLine(line);
  return line.quantity * line.unitPriceCents;
}

export function invoiceSubtotalCents(lines) {
  assertLines(lines);
  return lines.reduce((subtotal, line) => subtotal + lineTotalCents(line), 0);
}

export function invoiceDiscountCents(subtotalCents) {
  assertCents(subtotalCents, "subtotalCents");
  if (subtotalCents < BULK_THRESHOLD_CENTS) return 0;
  return Math.round((subtotalCents * BULK_DISCOUNT_BASIS_POINTS) / 10_000);
}

export function invoiceTaxCents(taxableCents) {
  assertCents(taxableCents, "taxableCents");
  return Math.round((taxableCents * TAX_BASIS_POINTS) / 10_000);
}

export function invoiceTotalCents(lines) {
  const subtotalCents = invoiceSubtotalCents(lines);
  const discountCents = invoiceDiscountCents(subtotalCents);
  const taxableCents = subtotalCents - discountCents;
  return taxableCents + invoiceTaxCents(taxableCents);
}

export function invoiceSummary(lines) {
  const subtotalCents = invoiceSubtotalCents(lines);
  const discountCents = invoiceDiscountCents(subtotalCents);
  const taxableCents = subtotalCents - discountCents;
  const taxCents = invoiceTaxCents(taxableCents);

  return {
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: taxableCents + taxCents,
  };
}

function assertLines(lines) {
  if (!Array.isArray(lines)) {
    throw new TypeError("lines must be an array");
  }
}

function assertLine(line) {
  if (
    typeof line !== "object" ||
    line === null ||
    !Number.isInteger(line.quantity) ||
    line.quantity < 0 ||
    !Number.isInteger(line.unitPriceCents) ||
    line.unitPriceCents < 0
  ) {
    throw new TypeError("each line needs non-negative integer values");
  }
}

function assertCents(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}
