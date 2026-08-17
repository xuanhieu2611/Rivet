import assert from "node:assert/strict";
import { test } from "node:test";

import { invoiceSubtotalCents, invoiceSummary, invoiceTotalCents } from "../src/invoice.js";

test("invoice callers can price an ordinary invoice through invoice.js", () => {
  const lines = [
    { quantity: 2, unitPriceCents: 1250 },
    { quantity: 1, unitPriceCents: 500 },
  ];

  assert.equal(invoiceSubtotalCents(lines), 3000);
  assert.equal(invoiceTotalCents(lines), 3248);
});

test("invoiceSummary exposes the existing integer-cent breakdown", () => {
  assert.deepEqual(invoiceSummary([{ quantity: 1, unitPriceCents: 2500 }]), {
    subtotalCents: 2500,
    discountCents: 0,
    taxCents: 206,
    totalCents: 2706,
  });
});
