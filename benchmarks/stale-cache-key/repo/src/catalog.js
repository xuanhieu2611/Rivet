import { productSummaryCache, productSummaryCacheKey } from "./cache.js";

const PRODUCT_CATALOG = {
  "acme:lamp": {
    "en-US": {
      USD: { name: "Desk lamp", priceCents: 1999 },
      EUR: { name: "Schreibtischlampe", priceCents: 1799 },
    },
    "fr-FR": {
      USD: { name: "Lampe de bureau", priceCents: 1999 },
      EUR: { name: "Lampe de bureau", priceCents: 1799 },
    },
  },
  "northwind:lamp": {
    "en-US": {
      USD: { name: "Northwind lamp", priceCents: 2499 },
      EUR: { name: "Northwind lamp", priceCents: 2299 },
    },
  },
};

export function getProductSummary({ tenantId, productId, locale, currency }) {
  assertRequestPart(tenantId, "tenantId");
  assertRequestPart(productId, "productId");
  assertRequestPart(locale, "locale");
  assertRequestPart(currency, "currency");

  const key = productSummaryCacheKey({ tenantId, productId, locale, currency });
  const cached = productSummaryCache.get(key);
  if (cached) return cached;

  const product = PRODUCT_CATALOG[`${tenantId}:${productId}`]?.[locale]?.[currency];
  if (!product) {
    throw new RangeError("product summary is not available for this request");
  }

  const summary = { tenantId, productId, locale, currency, ...product };
  productSummaryCache.set(key, summary);
  return summary;
}

function assertRequestPart(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}
