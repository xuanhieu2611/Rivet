import assert from "node:assert/strict";
import { test } from "node:test";

import {
  invoiceDiscountCents,
  invoiceSubtotalCents,
  invoiceTaxCents,
  invoiceTotalCents,
  lineTotalCents,
} from "../src/pricing.js";
import { invoiceTotalCents as invoiceApiTotalCents } from "../src/invoice.js";

test("the extracted pricing module preserves threshold and rounding", () => {
  const lines = [{ quantity: 3, unitPriceCents: 3335 }];

  assert.equal(lineTotalCents(lines[0]), 10005);
  assert.equal(invoiceSubtotalCents(lines), 10005);
  assert.equal(invoiceDiscountCents(10005), 500);
  assert.equal(invoiceTaxCents(9505), 784);
  assert.equal(invoiceTotalCents(lines), 10289);
  assert.equal(invoiceApiTotalCents(lines), 10289);
});

test("empty invoices retain their zero behavior", () => {
  assert.equal(invoiceSubtotalCents([]), 0);
  assert.equal(invoiceTotalCents([]), 0);
});

test("the extracted functions retain line and cents validation", () => {
  assert.throws(() => lineTotalCents({ quantity: -1, unitPriceCents: 100 }), TypeError);
  assert.throws(() => invoiceSubtotalCents("not lines"), TypeError);
  assert.throws(() => invoiceDiscountCents(10.5), TypeError);
});
