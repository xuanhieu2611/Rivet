import assert from "node:assert/strict";
import { test } from "node:test";

import { qualifiesForBulkDiscount } from "../src/discount.js";

test("the threshold excludes every quantity below ten", () => {
  for (const quantity of [0, 1, 9]) {
    assert.equal(qualifiesForBulkDiscount(quantity), false, `quantity ${quantity}`);
  }
});

test("the threshold includes ten and larger quantities", () => {
  for (const quantity of [10, 11, 100]) {
    assert.equal(qualifiesForBulkDiscount(quantity), true, `quantity ${quantity}`);
  }
});

test("quantity validation remains strict", () => {
  for (const quantity of [-1, 10.5, "10"]) {
    assert.throws(() => qualifiesForBulkDiscount(quantity), TypeError);
  }
});
