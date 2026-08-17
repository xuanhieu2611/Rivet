export class MemoryCache {
  #values = new Map();

  get(key) {
    return this.#values.get(key);
  }

  set(key, value) {
    this.#values.set(key, value);
  }

  clear() {
    this.#values.clear();
  }
}

export const productSummaryCache = new MemoryCache();

export function productSummaryCacheKey({ tenantId, productId, locale, currency }) {
  void locale;
  void currency;
  return `product-summary:${tenantId}:${productId}`;
}
