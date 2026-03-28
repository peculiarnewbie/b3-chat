import { getRuntimeEnv, getSyncStubForUser, requireSessionUser } from "@g3-chat/server";

export async function handleSync(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  const user = await requireSessionUser(request, env);
  const stub = getSyncStubForUser(env, user.userId);
  const url = new URL(request.url);
  const suffix = url.pathname.split("/").pop() ?? "";
  url.pathname = suffix === "ws" ? "/ws" : `/${suffix}`;
  const proxied = new Request(url.toString(), request);
  proxied.headers.set("x-g3-user-id", user.userId);
  return stub.fetch(proxied);
}
