# Captured job replays

This directory holds git-trackable fixtures for `pnpm demo:capture` and `pnpm demo:replay`.

A fixture is a named directory (`demo/replays/<name>/`) containing `job.json`, `events.ndjson`,
`artifacts/` and `commands/`. Checkpoints are not captured: replay drives the timeline and the
detail page, not a sandbox restore.

Names are lowercase kebab-case and are passed explicitly
(`pnpm demo:capture <jobId> --name booking`). They are never inferred from a job title.

`booking/` is a redacted capture of real job `9b3056ce-4cc9-490f-8a0e-854310af0ddf`, which completed
against the level-6 booking issue and opened
[pull request #3](https://github.com/xuanhieu2611/rivet-demo-booking/pull/3). Its 344 events include
a rejected first `submit_plan` call, the corrected structured plan, six changed files, deterministic
validation, independent approval and publication. The model did not produce a failed test or a
review revision, and the fixture does not pretend otherwise.

Recorded playback takes about 7 minutes 32 seconds. `pnpm demo:replay booking --speed 0.1`
compresses it to roughly 45 seconds while preserving event order; `--speed 0` is the fast structural
check.
