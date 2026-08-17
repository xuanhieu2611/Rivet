import assert from "node:assert/strict";
import { test } from "node:test";

import { qualifiesForBulkDiscount } from "../src/discount.js";

test("ten items qualify for the bulk discount", () => {
  assert.equal(qualifiesForBulkDiscount(10), true);
});

test("smaller orders do not qualify", () => {
  assert.equal(qualifiesForBulkDiscount(9), false);
});
