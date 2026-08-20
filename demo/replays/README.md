# Captured job replays

This directory holds git-trackable fixtures for `pnpm demo:capture` and `pnpm demo:replay`.

A fixture is a named directory (`demo/replays/<name>/`) containing `job.json`, `events.ndjson`,
`artifacts/` and `commands/`. Checkpoints are not captured: replay drives the timeline and the
detail page, not a sandbox restore.

Names are lowercase kebab-case and are passed explicitly
(`pnpm demo:capture <jobId> --name booking`). They are never inferred from a job title.

The booking capture that drives the public demo is not here yet. It lands after the demo repository
and seeded issue exist. Until then, acceptance run E builds a temporary fixture in the integration
suite.
