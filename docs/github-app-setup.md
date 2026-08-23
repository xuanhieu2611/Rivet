# GitHub App setup

Rivet uses a GitHub App for repository selection, issue intake, authenticated cloning, and pull
request publication. The same App can identify the single GitHub account allowed to use the local
control plane.

Keep the App limited to repositories you are comfortable letting Rivet modify. Start with a
throwaway repository while validating your setup.

## 1. Create the App

While signed in to GitHub, open <https://github.com/settings/apps/new> and configure:

| Setting                                | Local value                               |
| -------------------------------------- | ----------------------------------------- |
| Homepage URL                           | `http://localhost:3000`                   |
| Callback URL                           | `http://localhost:3000/api/auth/callback` |
| Setup URL                              | `http://localhost:3000/api/github/setup`  |
| User authorization during installation | Disabled                                  |
| Webhook                                | Inactive, with no webhook URL or events   |
| Installation scope                     | Your account or development organization  |

Request only these repository permissions:

| Permission    | Access         |
| ------------- | -------------- |
| Contents      | Read and write |
| Issues        | Read-only      |
| Metadata      | Read-only      |
| Pull requests | Read and write |

Do not request organization permissions or subscribe to webhook events. If you use a URL other than
`http://localhost:3000`, replace the origin in the homepage, callback, and setup URLs with that
origin.

## 2. Generate credentials

After creating the App:

1. Record its App ID, slug, Client ID, and Client secret.
2. Generate and download a private key.
3. Install the App on selected repositories only.
4. Encode the PEM file as one line:

```bash
base64 < path/to/private-key.pem | tr -d '\n'
```

The encoded value is still a private credential. Base64 is encoding, not encryption. Never put the
PEM, encoded value, installation token, or model key in Git, an issue, a prompt, or a command
argument.

## 3. Configure Rivet

Copy `.env.example` to `.env.local` and set:

```dotenv
RIVET_GITHUB="app"
GITHUB_APP_ID="123456"
GITHUB_APP_PRIVATE_KEY="BASE64_ENCODED_PEM"
GITHUB_APP_SLUG="your-app-slug"
GITHUB_APP_CLIENT_ID="Iv1.0000000000000000"
GITHUB_APP_CLIENT_SECRET="your-client-secret"
RIVET_APP_URL="http://localhost:3000"
```

For single-owner sign-in, also set:

```dotenv
RIVET_AUTH="github"
RIVET_OWNER_GITHUB_LOGIN="your-github-login"
RIVET_SESSION_SECRET="at-least-32-random-characters"
```

Generate a session secret with:

```bash
openssl rand -hex 32
```

Authentication can remain `off` for local development, but that mode is refused when
`NODE_ENV=production`. The owner login is checked on every request, and rotating the session secret
invalidates existing sessions.

## 4. Verify the installation

Start Rivet, then open <http://localhost:3000/settings/github>:

```bash
pnpm db:migrate
pnpm dev
```

The settings page should list the App installation and its accessible repositories. Create a job
from an issue in a throwaway repository and confirm that it ends with a branch and pull request.

If the installation is missing, check that the Setup URL matches Rivet's origin, the App is
installed on at least one repository, and the App credentials in `.env.local` belong to the same
App.

## Security notes

Installation tokens remain on the trusted worker host and are never passed to the sandbox. Rivet
registers minted tokens for log and durable-write redaction, but redaction is a safety net rather
than the security boundary. Read [SECURITY.md](../SECURITY.md) before granting the App access to
non-throwaway repositories.
