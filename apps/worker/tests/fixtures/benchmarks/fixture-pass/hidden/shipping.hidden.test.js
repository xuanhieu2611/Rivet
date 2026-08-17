// RIVET_HIDDEN_SENTINEL_7f3c1a9e4b2d
//
// The boundary the public suite never touches. If this string ever appears in a
// job container, a command transcript, an event, an artifact or a checkpoint
// patch, acceptance run C has found a leak.
import assert from "node:assert/strict";
import { test } from "node:test";

import { HEAVY_RATE, LIGHT_RATE, shippingCost } from "../src/shipping.js";

test("exactly the threshold weight is charged the heavy rate", () => {
  assert.equal(shippingCost(5), HEAVY_RATE);
});

test("just below the threshold is charged the light rate", () => {
  assert.equal(shippingCost(4.999), LIGHT_RATE);
});

test("the rates either side of the boundary are unchanged", () => {
  assert.equal(shippingCost(0), LIGHT_RATE);
  assert.equal(shippingCost(50), HEAVY_RATE);
});
