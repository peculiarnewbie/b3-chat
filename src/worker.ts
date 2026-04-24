import { setRuntimeEnv, type AppEnv, createAuthIssuer } from "@b3-chat/server";
import { createClient } from "@openauthjs/openauth/client";
import { handleBootstrap } from "./api/bootstrap";
import { handleSession } from "./api/session";
import { handleModels } from "./api/models";
import { handleSync } from "./api/sync";
import { handleUploadPresign } from "./api/uploads-presign";
import { handleUploadBlobGet, handleUploadBlobPut } from "./api/uploads-blob";
import { handleUploadComplete } from "./api/uploads-complete";
import { BUILD_INFO } from "./lib/build-info";

// Re-export Durable Object class so Cloudflare can discover it
export { SyncEngineDurableObject } from "./server/sync-engine";

type Env = AppEnv & {
  ASSETS: { fetch(request: Request): Promise<Response> };
};

function serializeCookie(
  name: string,
  value: string,
  opts: {
    maxAge?: number;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
  } = {},
) {
  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  if (opts.maxAge !== undefined) cookie += `; Max-Age=${opts.maxAge}`;
  cookie += `; Path=${opts.path ?? "/"}`;
  if (opts.secure !== false) cookie += `; Secure`;
  if (opts.httpOnly !== false) cookie += `; HttpOnly`;
  cookie += `; SameSite=${opts.sameSite ?? "Lax"}`;
  return cookie;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    setRuntimeEnv(env);

    const withVersionHeader = (response: Response) => {
      const wrapped = new Response(response.body, response);
      wrapped.headers.set("x-b3-version", BUILD_INFO.version);
      return wrapped;
    };

    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    const appHost = new URL(env.APP_PUBLIC_URL).hostname;
    const localHost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "0.0.0.0";

    if (!localHost && url.hostname !== appHost) {
      return withVersionHeader(new Response("Not found", { status: 404 }));
    }

    try {
      // OpenAuth expects to be mounted at the issuer root.
      if (
        pathname === "/authorize" ||
        pathname === "/token" ||
        pathname === "/.well-known/oauth-authorization-server" ||
        pathname === "/.well-known/jwks.json" ||
        pathname.startsWith("/google/")
      ) {
        const authIssuer = createAuthIssuer(env);
        return withVersionHeader(await authIssuer.fetch(request, env, ctx));
      }

      // API routing
      if (pathname.startsWith("/api/")) {
        if (pathname === "/api/auth/login" && method === "GET") {
          const client = createClient({
            clientID: "b3-chat",
            issuer: env.APP_PUBLIC_URL,
          });
          const { url: authUrl } = await client.authorize(
            `${env.APP_PUBLIC_URL}/api/auth/callback`,
            "code",
            { provider: "google" },
          );
          return withVersionHeader(Response.redirect(authUrl, 302));
        }

        if (pathname === "/api/auth/callback" && method === "GET") {
          const code = url.searchParams.get("code");
          if (!code) {
            return withVersionHeader(new Response("Missing code", { status: 400 }));
          }
          const tokenResponse = await createAuthIssuer(env).fetch(
            new Request(`${env.APP_PUBLIC_URL}/token`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                code,
                redirect_uri: `${env.APP_PUBLIC_URL}/api/auth/callback`,
                grant_type: "authorization_code",
                client_id: "b3-chat",
                code_verifier: "",
              }),
            }),
            env,
            ctx,
          );
          if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            return withVersionHeader(
              new Response(`Authentication failed: ${errorText}`, { status: tokenResponse.status }),
            );
          }
          const tokens = (await tokenResponse.json()) as {
            access_token: string;
            refresh_token: string;
            expires_in: number;
          };
          const headers = new Headers();
          headers.append(
            "Set-Cookie",
            serializeCookie("auth_access_token", tokens.access_token, {
              maxAge: tokens.expires_in,
            }),
          );
          headers.append(
            "Set-Cookie",
            serializeCookie("auth_refresh_token", tokens.refresh_token, {
              maxAge: 60 * 60 * 24 * 365,
            }),
          );
          headers.set("Location", "/");
          return withVersionHeader(new Response(null, { status: 302, headers }));
        }

        if (pathname === "/api/auth/logout" && method === "POST") {
          const headers = new Headers();
          headers.append("Set-Cookie", serializeCookie("auth_access_token", "", { maxAge: 0 }));
          headers.append("Set-Cookie", serializeCookie("auth_refresh_token", "", { maxAge: 0 }));
          headers.set("Location", "/");
          return withVersionHeader(new Response(null, { status: 302, headers }));
        }

        if (pathname === "/api/session" && method === "GET")
          return withVersionHeader(await handleSession(request));

        if (pathname === "/api/bootstrap" && method === "GET")
          return withVersionHeader(await handleBootstrap(request));

        if (pathname === "/api/models" && method === "GET")
          return withVersionHeader(await handleModels(request));

        if (pathname.startsWith("/api/sync/")) return withVersionHeader(await handleSync(request));

        if (pathname === "/api/uploads/presign" && method === "POST")
          return withVersionHeader(await handleUploadPresign(request));

        if (pathname.startsWith("/api/uploads/blob/")) {
          if (method === "PUT") return withVersionHeader(await handleUploadBlobPut(request));
          if (method === "GET") return withVersionHeader(await handleUploadBlobGet(request));
        }

        if (pathname === "/api/uploads/complete" && method === "POST")
          return withVersionHeader(await handleUploadComplete(request));

        return withVersionHeader(new Response("Not found", { status: 404 }));
      }

      // Serve static assets, with SPA fallback to index.html
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status === 404) {
        return withVersionHeader(
          await env.ASSETS.fetch(new Request(new URL("/index.html", url.origin))),
        );
      }

      // Fingerprinted static assets (Vite build output) can be cached forever
      const headers = new Headers(assetResponse.headers);
      headers.set("cache-control", "public, max-age=31536000, immutable");
      headers.set("x-b3-version", BUILD_INFO.version);
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
        webSocket: (assetResponse as any).webSocket,
      });
    } catch (error) {
      if (error instanceof Response) return withVersionHeader(error);
      console.error("Unhandled error:", error);
      return withVersionHeader(new Response("Internal Server Error", { status: 500 }));
    }
  },
} satisfies ExportedHandler<Env>;
