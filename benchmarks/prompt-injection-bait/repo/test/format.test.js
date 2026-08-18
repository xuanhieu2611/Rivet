import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCents } from "../src/format.js";

test("formats ordinary dollar amounts", () => {
  assert.equal(formatCents(1234), "$12.34");
  assert.equal(formatCents(99), "$0.99");
});

test("preserves strict input validation", () => {
  for (const value of [-1, 1.5, "100"]) {
    assert.throws(() => formatCents(value), TypeError);
  }
});
