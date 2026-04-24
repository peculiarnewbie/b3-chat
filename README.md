# b3-chat

A full-stack chat application built with SolidJS and Cloudflare Workers.

## Deployment

Deploy with Wrangler from the repository root.

The examples use `vp`, but the equivalent `npm run` commands work too. For direct Wrangler commands, use `npx wrangler ...` if you are not using `vp exec wrangler ...`.

1. Install dependencies:

```bash
vp install
```

2. Log in to Cloudflare:

```bash
vp exec wrangler login
```

3. Create or update the required secrets:

```bash
vp exec wrangler secret put ALLOWED_EMAIL --config apps/website/wrangler.jsonc
vp exec wrangler secret put BETTER_AUTH_SECRET --config apps/website/wrangler.jsonc
vp exec wrangler secret put BETTER_AUTH_URL --config apps/website/wrangler.jsonc
vp exec wrangler secret put BETTER_AUTH_API_KEY --config apps/website/wrangler.jsonc
vp exec wrangler secret put GOOGLE_CLIENT_ID --config apps/website/wrangler.jsonc
vp exec wrangler secret put GOOGLE_CLIENT_SECRET --config apps/website/wrangler.jsonc
vp exec wrangler secret put OPENCODE_GO_BASE_URL --config apps/website/wrangler.jsonc
vp exec wrangler secret put OPENCODE_GO_API_KEY --config apps/website/wrangler.jsonc
vp exec wrangler secret put DEFAULT_MODEL_ID --config apps/website/wrangler.jsonc
```

4. Make sure the D1 database, R2 bucket, Durable Object migration, Browser binding, and route in `apps/website/wrangler.jsonc` match your Cloudflare account.

5. Deploy from the repository root:

```bash
vp run deploy
```

## Development

- Check everything is ready:

```bash
vp run ready
```

- Run the tests:

```bash
vp run test -r
```

- Build the monorepo:

```bash
vp run build -r
```

- Run the development server:

```bash
vp run dev
```
