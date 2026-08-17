import assert from "node:assert/strict";
import { test } from "node:test";

import { orderTotalCents } from "../src/discount.js";

test("the discount is rounded once across the whole order", () => {
  const lines = [
    { quantity: 5, unitPriceCents: 101 },
    { quantity: 5, unitPriceCents: 101 },
  ];

  assert.equal(orderTotalCents(lines), 909);
});

test("an empty order totals zero", () => {
  assert.equal(orderTotalCents([]), 0);
});

test("line validation rejects negative quantities and fractional prices", () => {
  assert.throws(() => orderTotalCents([{ quantity: -1, unitPriceCents: 100 }]), TypeError);
  assert.throws(() => orderTotalCents([{ quantity: 1, unitPriceCents: 10.5 }]), TypeError);
});
