# Demo assets

## Seed repositories

The public repositories are pushed from the same deterministic bare repositories produced by
`pnpm eval:build`. Their `main` commits therefore match the benchmark lockfiles exactly.

| role                       | public repository and issue                                                                     | benchmark mirror                     | pinned commit                              |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| Recorded headline, level 6 | [`rivet-demo-booking#1`](https://github.com/xuanhieu2611/rivet-demo-booking/issues/1)           | `benchmarks/rivet-demo-booking`      | `3e925b753637c20f718995ab7632a26270072131` |
| Reliable live run, level 4 | [`rivet-demo-reservations#5`](https://github.com/xuanhieu2611/rivet-demo-reservations/issues/5) | `benchmarks/rivet-demo-reservations` | `a3e66e5d92bff668804f30d830945e341fba88f9` |

Acceptance run G applies the known-good patches under `apps/worker/tests/fixtures/demo-solutions/`
and grades both cases through the production M10 grader in real containers. Those patches are test
evidence only and are never pushed to either seed repository.

The real booking run is captured under [`replays/booking/`](replays/booking/) and published as
[pull request #3](https://github.com/xuanhieu2611/rivet-demo-booking/pull/3). Replay it through the
production writers and UI in about 45 seconds with:

```bash
RIVET_REPLAY=on pnpm demo:replay booking --speed 0.1
```

Stop the worker first so it cannot claim the ordinary queued row before the replay process does.
