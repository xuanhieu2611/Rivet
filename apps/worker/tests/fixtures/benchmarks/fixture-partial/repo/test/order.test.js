import assert from "node:assert/strict";
import { test } from "node:test";

import { orderTotal } from "../src/order.js";

test("a small order is charged at full price", () => {
  assert.equal(orderTotal([{ quantity: 3, unitPriceCents: 250 }]), 750);
});

// A single line of ten units. The order qualifies and so does the line, so this
// case reads the same way under either rule - which is exactly the gap the
// hidden tests close.
test("a bulk line is discounted by ten percent", () => {
  assert.equal(orderTotal([{ quantity: 10, unitPriceCents: 100 }]), 900);
});

test("an invalid line is rejected", () => {
  assert.throws(() => orderTotal([{ quantity: -1, unitPriceCents: 100 }]), TypeError);
  assert.throws(() => orderTotal([{ quantity: 1, unitPriceCents: 1.5 }]), TypeError);
});
