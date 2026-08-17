import assert from "node:assert/strict";
import { test } from "node:test";

import { orderTotalCents, qualifiesForBulkDiscount } from "../src/discount.js";

test("ten items qualify for the bulk discount", () => {
  assert.equal(qualifiesForBulkDiscount(10), true);
});

test("an ordinary order can contain several lines", () => {
  assert.equal(
    orderTotalCents([
      { quantity: 2, unitPriceCents: 125 },
      { quantity: 3, unitPriceCents: 40 },
    ]),
    370,
  );
});

test("a qualifying whole-line order receives the discount", () => {
  assert.equal(orderTotalCents([{ quantity: 11, unitPriceCents: 100 }]), 990);
});
