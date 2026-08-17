import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { productSummaryCache } from "../src/cache.js";
import { getProductSummary } from "../src/catalog.js";

beforeEach(() => {
  productSummaryCache.clear();
});

test("currency is part of the cache identity", () => {
  const dollars = getProductSummary({
    tenantId: "acme",
    productId: "lamp",
    locale: "en-US",
    currency: "USD",
  });
  const euros = getProductSummary({
    tenantId: "acme",
    productId: "lamp",
    locale: "en-US",
    currency: "EUR",
  });

  assert.equal(dollars.currency, "USD");
  assert.equal(dollars.priceCents, 1999);
  assert.equal(euros.currency, "EUR");
  assert.equal(euros.priceCents, 1799);
});

test("tenant is part of the cache identity", () => {
  getProductSummary({
    tenantId: "acme",
    productId: "lamp",
    locale: "en-US",
    currency: "USD",
  });
  const northwind = getProductSummary({
    tenantId: "northwind",
    productId: "lamp",
    locale: "en-US",
    currency: "USD",
  });

  assert.equal(northwind.tenantId, "northwind");
  assert.equal(northwind.name, "Northwind lamp");
  assert.equal(northwind.priceCents, 2499);
});
