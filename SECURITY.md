# Security

Rivet executes untrusted code from arbitrary repositories and holds a credential that can push to
somebody's GitHub account. This file is the short version of how that is kept safe and what is not
covered. The long version, walking PRD §27 item by item with the code that satisfies each control
and the risks accepted rather than mitigated, is
[`docs/security-review.md`](docs/security-review.md).

## Supported use

**Rivet is a single-operator development project, not a hosted service.** It is designed for one
principal: one signed session, one allowlisted GitHub account, and no `users` table. There is no
multi-tenancy, no per-user authorization and no deployment hardening review.

Run it on your own machine. Do not expose it to a public network, and do not give the URL to a
second person expecting the two of you to be isolated from each other - you would not be.

## Reporting a vulnerability

Report privately to the project owner. Do not open a public issue for a security problem.

**Never include a live credential in a report.** Remove tokens, keys and connection strings from
logs, stack traces and examples first. A GitHub installation token, an `OPENROUTER_API_KEY` or a
Neon or Upstash connection string in an issue is itself an incident.

## Configuration that matters

Rivet's cheap-variant switches all refuse `NODE_ENV=production`, because a system that skips real
work looks perfectly healthy while lying about it:

| Variable          | Default  | Refused in production | What `off` means                                |
| ----------------- | -------- | --------------------- | ----------------------------------------------- |
| `RIVET_AUTH`      | `off`    | Yes                   | The control plane accepts unauthenticated calls |
| `RIVET_SANDBOX`   | `docker` | `off` refused         | Phases are simulated; no container runs         |
| `RIVET_AGENT`     | `pi`     | `off` refused         | No model session runs                           |
| `RIVET_GITHUB`    | `off`    | Yes                   | No pull request is published                    |
| `RIVET_EVAL`      | `off`    | Yes                   | The local `rivet-local:` seed scheme is inert   |
| `RIVET_TELEMETRY` | `off`    | **No**                | No traces or metrics are exported               |

`RIVET_TELEMETRY` is the deliberate exception: a worker with telemetry off is degraded and honest
rather than lying, and refusing to boot over it would take a deployment down to protect its
dashboards.

Running with `RIVET_AUTH=github` additionally requires `GITHUB_APP_CLIENT_ID`,
`GITHUB_APP_CLIENT_SECRET`, `RIVET_OWNER_GITHUB_LOGIN` and a `RIVET_SESSION_SECRET` of at least 32
characters. The owner login is re-checked on every request, so changing it signs out an existing
session immediately; rotating the session secret invalidates all sessions at once.

## Credentials

- Keep the GitHub App private key in `.env.local` only. Store it as base64-encoded PEM text and
  never commit it. Base64 is an encoding, not encryption.
- Installation tokens are short-lived (about an hour) and belong on the trusted worker host. They
  must never enter a sandbox environment, repository file, command argument, command transcript,
  event payload, log, artifact, span attribute or database row.
- The model provider credential stays on the worker host and is never passed to repository
  processes. Pi's `bash` tool would forward the worker's own environment into the container; Rivet
  ignores that environment, always.
- Every minted token is registered with `SecretRegistry` before it reaches its caller, and the
  redaction pass now covers durable writes (`job_events`, `job_commands`, `job_artifacts`) as well
  as logs. It is a safety net rather than a boundary: code must still not put a secret anywhere.
- Do not paste credentials into issues, prompts, pull requests or support requests.

## Repository and agent trust

Repository contents are untrusted data. README files, issue titles and bodies, source comments,
tests and generated output can contain prompt-injection text, and the agent must not treat that text
as a system instruction. See the threat model in the
[README](README.md#repository-prompt-injection-threat-model).

Repository code runs in a disposable container: non-root (uid 1000), `CapDrop: ALL`,
`no-new-privileges`, required memory, CPU and pid limits, no Docker socket, and a user-defined
bridge with `enable_icc=false`. Under `RIVET_SANDBOX=docker` the worker refuses to start if a probe
container can reach its own configured Postgres or Redis endpoint.

The coding harness runs in the trusted worker, so its active tools are asserted at session start to
equal the role's exact set - implementer, planner and reviewer each have a fixed allowlist, and the
planner and reviewer can write nothing and execute nothing. A harness tool that operated on the
worker filesystem would cross the intended boundary and the assertion fails the job.

## What is not covered

Stated so their absence reads as a decision. Reasons and remediation paths are in
[`docs/security-review.md`](docs/security-review.md) §6.

- **Egress is not restricted.** A malicious repository can still send its own contents to the
  internet from inside the sandbox. An egress allowlist or proxy is required to stop that and is not
  implemented.
- **The harness process itself is not sandboxed.** It runs trusted in the process holding the model
  key.
- **No multi-tenancy**, and no per-session revocation.
- **Container escape is not defended against** beyond the container hardening above. Docker is the
  isolation backend; a stronger boundary would be gVisor, Firecracker or a per-job VM.
- **No deployment hardening.** No TLS termination, WAF, network policy or managed secret store,
  because there is no hosted environment.

## Automated checks

`.github/workflows/security.yml` runs on every pull request and every push to `main`, independently
of the other CI jobs:

- **CodeQL** over JavaScript/TypeScript with the `security-extended` queries.
- **`pnpm audit`**, failing on `high` and `critical` advisories.
- **gitleaks** over the full history and the diff, failing on any finding.

Allowlist entries in `.gitleaks.toml` and audit ignores in the workflow must carry a comment saying
why the finding is not a live credential or why the advisory is unreachable. An entry with no
comment is a bug.
