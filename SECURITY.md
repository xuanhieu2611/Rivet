# Security notes

Rivet is a local development project, not a public service. The current milestone has no user
accounts, sessions, CSRF protection, rate limiting, or per-user authorization. GitHub installations
are global records, so anyone who can reach the development server could use an installed App. Do
not deploy this version to a public network or use it with a repository you do not control.

## Credentials

- Keep the GitHub App private key in `.env.local` only. Store it as base64-encoded PEM text and
  never commit it.
- Installation tokens are short-lived and belong on the trusted worker host. They must never enter a
  sandbox environment, repository file, command argument, command transcript, event payload, log,
  artifact, or database row.
- The LLM provider credential stays on the worker host and is never passed to repository processes.
- Do not paste credentials into issues, prompts, pull requests, or support requests.

## Repository and agent trust

Repository contents are untrusted data. README files, issues, source comments, tests, and generated
output can contain prompt-injection text, and the agent must not treat that text as a system
instruction. Repository code runs in a disposable sandbox with only the credentials required for
that job. The trusted worker owns the model and GitHub credentials; the sandbox does not receive the
Docker socket or those credentials.

The coding harness runs in the trusted worker, so its active tools must remain explicitly restricted
to Rivet's sandbox-backed tools. A harness tool that operates on the worker filesystem would cross
the intended boundary.

## Reporting

Do not report a vulnerability with live credentials or a repository token. Remove secrets from logs
and examples first. Until authentication and a private deployment process exist, treat the local
operator as the only trusted user and report security concerns privately to the project owner.
