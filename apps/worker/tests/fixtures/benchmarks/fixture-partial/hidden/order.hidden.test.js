// RIVET_HIDDEN_SENTINEL_7f3c1a9e4b2d
//
// The rule the issue states and the public suite never distinguishes. If this
// string ever appears in a job container, a command transcript, an event, an
// artifact or a checkpoint patch, acceptance run C has found a leak.
import assert from "node:assert/strict";
import { test } from "node:test";

import { orderTotal } from "../src/order.js";

test("two lines below the threshold are never discounted", () => {
  // Twelve units in the order, six on each line. An implementation that reads
  // the discount as an order-level rule returns 1080 here and is wrong.
  assert.equal(
    orderTotal([
      { quantity: 6, unitPriceCents: 100 },
      { quantity: 6, unitPriceCents: 100 },
    ]),
    1200,
  );
});

test("only the qualifying line is discounted", () => {
  assert.equal(
    orderTotal([
      { quantity: 10, unitPriceCents: 100 },
      { quantity: 2, unitPriceCents: 100 },
    ]),
    1100,
  );
});

test("a line above the threshold is discounted too", () => {
  assert.equal(orderTotal([{ quantity: 20, unitPriceCents: 100 }]), 1800);
});
