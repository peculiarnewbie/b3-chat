import { getRuntimeEnv, getSyncStub, requireSession } from "@b3-chat/server";

export async function handleSync(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  await requireSession(request, env);
  const stub = await getSyncStub(env);
  const url = new URL(request.url);
  const suffix = url.pathname.split("/").pop() ?? "";
  url.pathname = suffix === "ws" ? "/ws" : `/${suffix}`;
  return stub.fetch(new Request(url.toString(), request));
}
