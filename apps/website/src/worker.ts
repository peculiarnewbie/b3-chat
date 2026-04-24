import { setRuntimeEnv, type AppEnv } from "@b3-chat/server";
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
    setRuntimeEnv(env);

    const withVersionHeader = (response: Response) => {
      const headers = new Headers(response.headers);
      headers.set("x-b3-version", BUILD_INFO.version);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
        webSocket: (response as any).webSocket,
      });
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
      // API routing
      if (pathname.startsWith("/api/")) {
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
