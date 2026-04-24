# b3-chat

A full-stack chat application built with SolidJS and Cloudflare Workers.

## Deployment

See [Deployment Guide](docs/deployment.md) for the full Cloudflare Access, R2 uploads, OpenCode Go, and Exa setup.

Deploy from the repository root:

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
