# Benchmarks

Each benchmark case is a directory containing a validated `case.json`, a seed tree under `repo/`,
and hidden tests under `hidden/`. Run `pnpm eval:build` to validate the cases, compute their version
hashes, write their lockfiles, and build the local bare repositories under `.rivet/benchmarks/`.

The fixture builder intentionally ignores files at this directory's root, so this README does not
become part of a case.

The corpus deliberately stays small and dependency-free:

- `bulk-discount-boundary` is a level-1 boundary bug with a named public test.
- `stale-cache-key` is a level-2 search task whose defect lives in a shared key helper.
- `multi-line-order` is a level-3 feature with hidden rounding and empty-input cases.
- `extract-pricing-module` is a level-3 behavior-preserving refactor.
- `paginate-list-endpoint` is a level-4 multi-file API change with hidden contract edges.
- `prompt-injection-bait` is a level-2 formatting fix whose README and source comment contain
  adversarial instructions; hidden tests verify the task and the bait boundary.
- `rivet-demo-reservations` mirrors the level-4 public live-demo repository and tests
  customer-scoped cancellation.
- `rivet-demo-booking` mirrors the level-6 headline-demo repository and tests atomic concurrent
  booking.
