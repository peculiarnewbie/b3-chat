import { setRuntimeEnv, type AppEnv } from "@b3-chat/server";
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
    setRuntimeEnv(env);
    const startedAt = Date.now();

    const withVersionHeader = (response: Response) => {
      const next = new Response(response.body, response);
      next.headers.set("x-b3-version", BUILD_INFO.version);
      return next;
    };

    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Debug: log every request that reaches the worker
    console.log(
      JSON.stringify({
        scope: "worker",
        event: "request_start",
        method,
        pathname,
        version: BUILD_INFO.version,
      }),
    );

    try {
      // API routing
      if (pathname.startsWith("/api/")) {
        if (pathname.startsWith("/api/auth/")) {
          console.log(
            JSON.stringify({
              scope: "worker",
              event: "route_auth",
              method,
              pathname,
            }),
          );
          const response = withVersionHeader(await handleAuth(request));
          console.log(
            JSON.stringify({
              scope: "worker",
              event: "request_end",
              method,
              pathname,
              status: response.status,
              durationMs: Date.now() - startedAt,
            }),
          );
          return response;
        }

        if (pathname === "/api/session" && method === "GET") {
          const response = withVersionHeader(await handleSession(request));
          console.log(
            JSON.stringify({
              scope: "worker",
              event: "request_end",
              method,
              pathname,
              status: response.status,
              durationMs: Date.now() - startedAt,
            }),
          );
          return response;
        }

        if (pathname === "/api/models" && method === "GET") {
          const response = withVersionHeader(await handleModels(request));
          console.log(
            JSON.stringify({
              scope: "worker",
              event: "request_end",
              method,
              pathname,
              status: response.status,
              durationMs: Date.now() - startedAt,
            }),
          );
          return response;
        }

        if (pathname.startsWith("/api/sync/")) {
          const response = withVersionHeader(await handleSync(request));
          console.log(
            JSON.stringify({
              scope: "worker",
              event: "request_end",
              method,
              pathname,
              status: response.status,
              durationMs: Date.now() - startedAt,
            }),
          );
          return response;
        }

        if (pathname === "/api/uploads/presign" && method === "POST") {
          const response = withVersionHeader(await handleUploadPresign(request));
          console.log(
            JSON.stringify({
              scope: "worker",
              event: "request_end",
              method,
              pathname,
              status: response.status,
              durationMs: Date.now() - startedAt,
            }),
          );
          return response;
        }

        if (pathname.startsWith("/api/uploads/blob/")) {
          if (method === "PUT") {
            const response = withVersionHeader(await handleUploadBlobPut(request));
            console.log(
              JSON.stringify({
                scope: "worker",
                event: "request_end",
                method,
                pathname,
                status: response.status,
                durationMs: Date.now() - startedAt,
              }),
            );
            return response;
          }
          if (method === "GET") {
            const response = withVersionHeader(await handleUploadBlobGet(request));
            console.log(
              JSON.stringify({
                scope: "worker",
                event: "request_end",
                method,
                pathname,
                status: response.status,
                durationMs: Date.now() - startedAt,
              }),
            );
            return response;
          }
        }

        if (pathname === "/api/uploads/complete" && method === "POST") {
          const response = withVersionHeader(await handleUploadComplete(request));
          console.log(
            JSON.stringify({
              scope: "worker",
              event: "request_end",
              method,
              pathname,
              status: response.status,
              durationMs: Date.now() - startedAt,
            }),
          );
          return response;
        }

        return withVersionHeader(new Response("Not found", { status: 404 }));
      }

      // Serve static assets, with SPA fallback to index.html
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status === 404) {
        const response = withVersionHeader(
          await env.ASSETS.fetch(new Request(new URL("/index.html", url.origin))),
        );
        console.log(
          JSON.stringify({
            scope: "worker",
            event: "request_end",
            method,
            pathname,
            status: response.status,
            durationMs: Date.now() - startedAt,
            spaFallback: true,
          }),
        );
        return response;
      }
      const response = withVersionHeader(assetResponse);
      console.log(
        JSON.stringify({
          scope: "worker",
          event: "request_end",
          method,
          pathname,
          status: response.status,
          durationMs: Date.now() - startedAt,
          spaFallback: false,
        }),
      );
      return response;
    } catch (error) {
      if (error instanceof Response) return withVersionHeader(error);
      console.error(
        JSON.stringify({
          scope: "worker",
          event: "request_error",
          method,
          pathname,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }),
      );
      return withVersionHeader(new Response("Internal Server Error", { status: 500 }));
    }
  },
} satisfies ExportedHandler<Env>;
