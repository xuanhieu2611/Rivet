import assert from "node:assert/strict";
import { test } from "node:test";

import { shippingCost } from "../src/shipping.js";

test("a light parcel is charged the light rate", () => {
  assert.equal(shippingCost(2), 5);
});

test("a heavy parcel is charged the heavy rate", () => {
  assert.equal(shippingCost(6), 12);
});

test("an invalid weight is rejected", () => {
  for (const weight of [-1, Number.NaN, "5"]) {
    assert.throws(() => shippingCost(weight), TypeError);
  }
});
