# Milestone 9: GitHub App setup

This is the Stage 0 checklist for local development. The App is deliberately scoped to the throwaway
demo repository until the rest of Milestone 9 is implemented.

## Create the GitHub App

While signed in to the `xuanhieu2611` GitHub account, open <https://github.com/settings/apps/new>
and create an App with these settings:

| Setting                                | Value                                    |
| -------------------------------------- | ---------------------------------------- |
| App name                               | `Rivet Local` or another unique name     |
| Homepage URL                           | `http://localhost:3000`                  |
| Setup URL                              | `http://localhost:3000/api/github/setup` |
| Webhook                                | Inactive, with no webhook URL or events  |
| User authorization during installation | Disabled                                 |
| Installation scope                     | Only this account                        |

Request only these **repository** permissions:

| Permission    | Access         |
| ------------- | -------------- |
| Contents      | Read and write |
| Issues        | Read-only      |
| Metadata      | Read-only      |
| Pull requests | Read and write |

Do not request any other repository or organization permissions, and do not subscribe to webhook
events. The Setup URL is local because Rivet has no authenticated public deployment in this
milestone.

After creating the App:

1. Record the App ID, App slug, and Client ID.
2. Generate a private key and keep the downloaded PEM file private.
3. Install the App on `xuanhieu2611/rivet-demo-target` only.
4. Do not install it on `xuanhieu2611/rivet-fixture-node`; that repository is reserved for later
   evaluation and the existing demos.

The throwaway public target is already created at
<https://github.com/xuanhieu2611/rivet-demo-target> and is seeded from the fixture repository.

## Configure local credentials

Copy `.env.example` to `.env.local`, then fill in the four GitHub App values:

```dotenv
GITHUB_APP_ID="123456"
GITHUB_APP_PRIVATE_KEY="BASE64_ENCODED_PEM"
GITHUB_APP_SLUG="rivet-local"
GITHUB_APP_CLIENT_ID="Iv1.0000000000000000"
```

Encode the downloaded PEM as one line without copying the key into Git or chat:

```bash
base64 < path/to/private-key.pem | tr -d '\n'
```

`.env.local` is ignored by Git. Do not put the private key, an installation token, or any other
credential in a prompt, event payload, command argument, artifact, or committed file.

The App configuration and these environment variables are optional until the GitHub adapter is
enabled. CI and the existing integration suites continue to run without them.

## Security boundary

Rivet has no authentication or per-user authorization yet. Keep the development server bound to a
local machine and do not expose it to a public network. See [`SECURITY.md`](../SECURITY.md) for the
threat model and the limitations that remain deferred to a later milestone.
