import type { AppEnv } from "@g3-chat/server";
import { handleAuth } from "./api/auth";
import { handleSession } from "./api/session";
import { handleModels } from "./api/models";
import { handleChatStream } from "./api/chat-stream";
import { handleStateMutate } from "./api/state-mutate";
import { handleSync } from "./api/sync";
import { handleUploadPresign } from "./api/uploads-presign";
import { handleUploadBlobGet, handleUploadBlobPut } from "./api/uploads-blob";
import { handleUploadComplete } from "./api/uploads-complete";

// Re-export Durable Object class so Cloudflare can discover it
export { SyncEngineDurableObject } from "./server/sync-engine";

type Env = AppEnv & {
  ASSETS: { fetch(request: Request): Promise<Response> };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Make env available to getRuntimeEnv() used throughout @g3-chat/server
    globalThis.__env__ = env;

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
          return await handleAuth(request);
        }

        if (pathname === "/api/session" && method === "GET") return await handleSession(request);

        if (pathname === "/api/models" && method === "GET") return await handleModels(request);

        if (/^\/api\/chat\/threads\/[^/]+\/stream$/.test(pathname) && method === "POST")
          return await handleChatStream(request);

        if (pathname === "/api/state/mutate" && method === "POST")
          return await handleStateMutate(request);

        if (pathname.startsWith("/api/sync/")) return await handleSync(request);

        if (pathname === "/api/uploads/presign" && method === "POST")
          return await handleUploadPresign(request);

        if (pathname.startsWith("/api/uploads/blob/")) {
          if (method === "PUT") return await handleUploadBlobPut(request);
          if (method === "GET") return await handleUploadBlobGet(request);
        }

        if (pathname === "/api/uploads/complete" && method === "POST")
          return await handleUploadComplete(request);

        return new Response("Not found", { status: 404 });
      }

      // Serve static assets, with SPA fallback to index.html
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status === 404) {
        return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin)));
      }
      return assetResponse;
    } catch (error) {
      if (error instanceof Response) return error;
      console.error("Unhandled error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
