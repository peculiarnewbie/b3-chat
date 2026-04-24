# Deployment Guide

Deploy from the repository root with Vite+ and Wrangler.

## 1. Install and Log In

```bash
vp install
vp exec wrangler login
```

## 2. Provision Cloudflare Resources

The Worker config is `wrangler.jsonc`. Two resources need one-time setup; the rest are declared in config and provisioned on deploy.

Create the private R2 bucket for attachments:

```bash
vp exec wrangler r2 bucket create b3-chat-uploads
```

Create the KV namespace for OpenAuth and copy the returned ID into `kv_namespaces` in `wrangler.jsonc`:

```bash
vp exec wrangler kv namespace create "OPENAUTH_STORAGE"
```

No setup required for:

- `SYNC_ENGINE` Durable Object — auto-provisioned on first deploy via the `migrations` block.
- `BROWSER` Browser Rendering binding — enabled per-account in the Cloudflare dashboard.
- `routes` — update the custom domain pattern in `wrangler.jsonc` to match your zone.

## 3. Configure Google OAuth

The app uses OpenAuth with Google OIDC. No Google client secret is needed because OpenAuth verifies Google's signed ID token against Google's public keys.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) > **APIs & Services** > **Credentials**.
2. **Create Credentials** > **OAuth client ID** > **Web application**.
3. **Authorized JavaScript origins**: your deployed origin, e.g. `https://chat.example.com`.
4. **Authorized redirect URIs**: `https://chat.example.com/google/callback`.
5. Copy the **Client ID** into `GOOGLE_CLIENT_ID` (see next section).

## 4. Configure Environment

Plain variables live in `wrangler.jsonc` under `vars`. Secrets are set with `wrangler secret put` (or bulk-uploaded — see below).

| Name                          | Kind   | Required | Description                                                                |
| ----------------------------- | ------ | -------- | -------------------------------------------------------------------------- |
| `APP_PUBLIC_URL`              | var    | yes      | Canonical public URL, e.g. `https://chat.example.com`.                     |
| `GOOGLE_CLIENT_ID`            | var    | yes      | OAuth client ID from §3.                                                   |
| `OWNER_EMAIL`                 | var    | yes      | The single Google account allowed to sign in. Others get `/forbidden`.     |
| `DEFAULT_MODEL_ID`            | var    | yes      | Model ID from your OpenCode Go catalog, or `"auto"` to let the app choose. |
| `OPENCODE_GO_MODEL_ALLOWLIST` | var    | no       | Comma-separated model IDs to expose. Omit to show the full catalog.        |
| `OPENCODE_GO_BASE_URL`        | secret | yes      | OpenCode Go API base URL.                                                  |
| `OPENCODE_GO_API_KEY`         | secret | yes      | OpenCode Go API key.                                                       |
| `UPLOAD_TOKEN_SECRET`         | secret | yes      | Signs attachment URLs. Generate with `openssl rand -hex 32`.               |
| `EXA_API_KEY`                 | secret | no       | Enables the paid Exa API. Without it, search uses Exa's free MCP endpoint. |

**Bulk-upload secrets** by filling in `.dev.vars` (copy from `.dev.vars.example`) and running:

```bash
vp exec wrangler secret bulk .dev.vars
```

## 5. Deploy

```bash
vp run deploy
```

This runs `vp build` followed by `wrangler deploy` from the repository root, stamping the build with the current git SHA.

## Local Development

Copy `.dev.vars.example` to `.dev.vars` and fill in the same secrets used in production.

Optionally set `DEV_AUTH_EMAIL` in `.dev.vars` to bypass Google sign-in on localhost when no auth cookie is present. This only affects local dev.
