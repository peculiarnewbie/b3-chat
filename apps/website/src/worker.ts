import type { AppEnv } from "@b3-chat/server";
import { handleAuth } from "./api/auth";
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Make env available to getRuntimeEnv() used throughout @b3-chat/server
    globalThis.__env__ = env;

    const withVersionHeader = (response: Response) => {
      const next = new Response(response.body, response);
      next.headers.set("x-b3-version", BUILD_INFO.version);
      return next;
    };

    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Debug: log every request that reaches the worker
    console.log(`[worker] ${method} ${pathname}`);

    try {
      // API routing
      if (pathname.startsWith("/api/")) {
        if (pathname.startsWith("/api/auth/")) {
          console.log(`[worker] routing to handleAuth: ${method} ${pathname}`);
          return withVersionHeader(await handleAuth(request));
        }

        if (pathname === "/api/session" && method === "GET")
          return withVersionHeader(await handleSession(request));

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
      return withVersionHeader(assetResponse);
    } catch (error) {
      if (error instanceof Response) return withVersionHeader(error);
      console.error("Unhandled error:", error);
      return withVersionHeader(new Response("Internal Server Error", { status: 500 }));
    }
  },
} satisfies ExportedHandler<Env>;
