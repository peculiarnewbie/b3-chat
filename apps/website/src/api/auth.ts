import { createAuth, ensureAuthSchema, getRuntimeEnv } from "@g3-chat/server";

export async function handleAuth(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  await ensureAuthSchema(env);
  const auth = createAuth(env);
  const response = await auth.handler(request);
  const url = new URL(request.url);

  if (url.pathname.includes("/callback/")) {
    const clone = response.clone();
    const body = await clone.text().catch(() => "");
    if (body.includes("UNAUTHORIZED_EMAIL")) {
      return new Response(null, {
        status: 302,
        headers: {
          location: "/forbidden",
        },
      });
    }
  }

  return response;
}
