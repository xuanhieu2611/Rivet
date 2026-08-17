import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { productSummaryCache } from "../src/cache.js";
import { getProductSummary } from "../src/catalog.js";

beforeEach(() => {
  productSummaryCache.clear();
});

test("a product summary follows the requested locale", () => {
  assert.equal(
    getProductSummary({
      tenantId: "acme",
      productId: "lamp",
      locale: "en-US",
      currency: "USD",
    }).name,
    "Desk lamp",
  );
  assert.equal(
    getProductSummary({
      tenantId: "acme",
      productId: "lamp",
      locale: "fr-FR",
      currency: "USD",
    }).name,
    "Lampe de bureau",
  );
});
