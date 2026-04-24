# Deployment Guide

Deploy from the repository root with Vite+ and Wrangler.

## 1. Install And Log In

```bash
vp install
vp exec wrangler login
```

## 2. Configure Cloudflare Resources

The Worker config is `apps/website/wrangler.jsonc`. Make sure these bindings match resources in your Cloudflare account:

- `UPLOADS`: private R2 bucket used for attachments.
- `SYNC_ENGINE`: Durable Object used for single-user sync state.
- `BROWSER`: Cloudflare Browser Rendering binding used by extraction tools.
- `routes`: custom domain route for the deployed app.

Create the private R2 bucket if needed:

```bash
vp exec wrangler r2 bucket create b3-chat-uploads
```

## 3. Configure Cloudflare Access

This app relies on Cloudflare Access for authentication and owner allowlisting. The app no longer manages Google OAuth, app-owned auth sessions, or auth database tables.

1. In Cloudflare One, go to **Access controls** > **Applications**.
2. Add a **Self-hosted** application.
3. Set the public hostname to your Worker custom domain, for example `chat.example.com`.
4. Add an Allow policy for the single owner, such as one email address, one domain, or one IdP group.
5. Select the identity provider you want to use.
6. Copy the application **AUD tag** from the Access application settings.
7. Note your Access team domain, for example `https://your-team.cloudflareaccess.com`.

Access is deny-by-default. Unauthorized users should be blocked by Cloudflare before requests reach the Worker.

## 4. Configure Attachment Blob Access

The R2 bucket stays private, but image attachments are passed to the model as short-lived signed URLs. The model fetcher will not have your browser's Cloudflare Access session, so the blob route must be reachable without interactive Access login.

Configure Cloudflare Access so this path is bypassed or excluded from the main application enforcement:

```text
/api/uploads/blob/*
```

The Worker still verifies every blob upload/read using a short-lived HMAC token. Requests without a valid token return `401`, except browser reads can also use an existing Access session when Cloudflare forwards the Access cookie/header.

Do not make the R2 bucket public.

## 5. Configure Worker Secrets

Set the app and Access config:

```bash
vp exec wrangler secret put UPLOAD_TOKEN_SECRET --config apps/website/wrangler.jsonc
vp exec wrangler secret put CLOUDFLARE_ACCESS_TEAM_DOMAIN --config apps/website/wrangler.jsonc
vp exec wrangler secret put CLOUDFLARE_ACCESS_AUD --config apps/website/wrangler.jsonc
```

Use values like:

```text
UPLOAD_TOKEN_SECRET=<openssl rand -hex 32>
CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=<Access application AUD tag>
```

`APP_PUBLIC_URL` is configured as a plain Wrangler variable in `apps/website/wrangler.jsonc` because it is not a secret. Update it if you deploy to a different hostname.

Sync state uses a fixed single-user Durable Object key. New deployments do not need to configure an owner ID. Existing deployments that previously stored data under an email-based key will appear fresh unless that data is migrated to the fixed key.

For local development only, you can set:

```bash
vp exec wrangler secret put DEV_AUTH_EMAIL --config apps/website/wrangler.jsonc
```

`DEV_AUTH_EMAIL` only applies on localhost when no Cloudflare Access JWT is present.

## 6. Configure OpenCode Go

The chat model provider is OpenCode Go. The app uses it for the model catalog and assistant requests.

```bash
vp exec wrangler secret put OPENCODE_GO_BASE_URL --config apps/website/wrangler.jsonc
vp exec wrangler secret put OPENCODE_GO_API_KEY --config apps/website/wrangler.jsonc
vp exec wrangler secret put DEFAULT_MODEL_ID --config apps/website/wrangler.jsonc
vp exec wrangler secret put OPENCODE_GO_MODEL_ALLOWLIST --config apps/website/wrangler.jsonc
```

Skip `OPENCODE_GO_MODEL_ALLOWLIST` if all models from the provider catalog should be visible.

## 7. Configure Exa Search

Search works without an Exa API key by using Exa's public MCP endpoint. To use the paid Exa API for structured search results, set `EXA_API_KEY`:

```bash
vp exec wrangler secret put EXA_API_KEY --config apps/website/wrangler.jsonc
```

Skip this secret if you want to use the free Exa MCP path.

## 8. Deploy

Deploy from the repository root:

```bash
vp run deploy
```

The deploy script builds `apps/website` and runs `wrangler deploy` from that app directory.
