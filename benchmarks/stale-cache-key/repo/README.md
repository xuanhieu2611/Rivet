# Stale cache key

The public suite demonstrates the locale collision. It intentionally does not exercise the other
request dimension that can collide after the locale fix; the hidden suite covers currency and a
second tenant. The defect is in the cache-key helper, not in the catalog lookup where the stale
value is observed.
