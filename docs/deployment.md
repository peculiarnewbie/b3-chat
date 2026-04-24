# Deployment Guide

Deploy from the repository root with Vite+ and Wrangler.

## 1. Install And Log In

```bash
vp install
vp exec wrangler login
```

## 2. Configure Cloudflare Resources

The Worker config is `wrangler.jsonc`. Make sure these bindings match resources in your Cloudflare account:

- `UPLOADS`: private R2 bucket used for attachments.
- `SYNC_ENGINE`: Durable Object used for single-user sync state.
- `BROWSER`: Cloudflare Browser Rendering binding used by extraction tools.
- `OPENAUTH_STORAGE`: KV namespace used by OpenAuth for tokens and state.
- `routes`: custom domain route for the deployed app.

Create the private R2 bucket if needed:

```bash
vp exec wrangler r2 bucket create b3-chat-uploads
```

Create the KV namespace for OpenAuth:

```bash
vp exec wrangler kv namespace create "OPENAUTH_STORAGE"
```

Copy the KV namespace ID into `wrangler.jsonc` under `kv_namespaces`.

## 3. Configure Google OAuth

The app uses OpenAuth with Google OIDC for authentication. You only need a Google OAuth client ID; there is no Google client secret for this flow because OpenAuth verifies Google's signed ID token with Google's public keys.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) > **APIs & Services** > **Credentials**.
2. Click **Create Credentials** > **OAuth client ID**.
3. Choose **Web application**.
4. Add your deployed origin to **Authorized JavaScript origins**, e.g. `https://chat.example.com`.
5. Add the callback URL to **Authorized redirect URIs**: `https://chat.example.com/google/callback`.
6. Copy the **Client ID** and set it as the `GOOGLE_CLIENT_ID` variable in `wrangler.jsonc`.
7. Set `OWNER_EMAIL` in `wrangler.jsonc` to the exact Google account email that is allowed to use this deployment.

`OWNER_EMAIL` is required. If someone tries to sign in with a different Google account, they are redirected to `/forbidden`.

## 4. Configure Worker Secrets

Set the app secrets:

```bash
vp exec wrangler secret put UPLOAD_TOKEN_SECRET
vp exec wrangler secret put OPENCODE_GO_BASE_URL
vp exec wrangler secret put OPENCODE_GO_API_KEY
```

Use values like:

```text
UPLOAD_TOKEN_SECRET=<openssl rand -hex 32>
OPENCODE_GO_BASE_URL=https://api.opencode.example.com
OPENCODE_GO_API_KEY=...
```

`APP_PUBLIC_URL`, `GOOGLE_CLIENT_ID`, and `OWNER_EMAIL` are configured as plain Wrangler variables in `wrangler.jsonc`. Update `APP_PUBLIC_URL` if you deploy to a different hostname.

For local development only, you can set:

```bash
vp exec wrangler secret put DEV_AUTH_EMAIL
```

`DEV_AUTH_EMAIL` only applies on localhost when no auth cookie is present.

## 5. Configure OpenCode Go

The chat model provider is OpenCode Go. The app uses it for the model catalog and assistant requests.

```bash
vp exec wrangler secret put DEFAULT_MODEL_ID
vp exec wrangler secret put OPENCODE_GO_MODEL_ALLOWLIST
```

Skip `OPENCODE_GO_MODEL_ALLOWLIST` if all models from the provider catalog should be visible.

## 6. Configure Exa Search

Search works without an Exa API key by using Exa's public MCP endpoint. To use the paid Exa API for structured search results, set `EXA_API_KEY`:

```bash
vp exec wrangler secret put EXA_API_KEY
```

Skip this secret if you want to use the free Exa MCP path.

## 7. Deploy

Deploy from the repository root:

```bash
vp run deploy
```

The deploy script runs `vp build` and `wrangler deploy` from the repository root.
