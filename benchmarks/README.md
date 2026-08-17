# Benchmarks

Each benchmark case is a directory containing a validated `case.json`, a seed tree under `repo/`,
and hidden tests under `hidden/`. Run `pnpm eval:build` to validate the cases, compute their version
hashes, write their lockfiles, and build the local bare repositories under `.rivet/benchmarks/`.

The fixture builder intentionally ignores files at this directory's root, so this README does not
become part of a case.
