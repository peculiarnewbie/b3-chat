import { getRuntimeEnv, getSyncStub, requireSession } from "@b3-chat/server";

export async function handleSync(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  const startedAt = Date.now();
  const url = new URL(request.url);
  console.log(
    JSON.stringify({
      scope: "sync-api",
      event: "handle_sync_start",
      method: request.method,
      pathname: url.pathname,
    }),
  );
  await requireSession(request, env);
  const stub = await getSyncStub(env);
  const suffix = url.pathname.split("/").pop() ?? "";
  url.pathname = suffix === "ws" ? "/ws" : `/${suffix}`;
  console.log(
    JSON.stringify({
      scope: "sync-api",
      event: "handle_sync_proxy",
      method: request.method,
      originalPathname: new URL(request.url).pathname,
      proxiedPathname: url.pathname,
      suffix,
    }),
  );
  const response = await stub.fetch(new Request(url.toString(), request));
  console.log(
    JSON.stringify({
      scope: "sync-api",
      event: "handle_sync_end",
      method: request.method,
      pathname: new URL(request.url).pathname,
      proxiedPathname: url.pathname,
      status: response.status,
      durationMs: Date.now() - startedAt,
    }),
  );
  return response;
}
