import { createAuth, ensureAuthSchema, getRuntimeEnv } from "@b3-chat/server";

export async function handleAuth(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  const url = new URL(request.url);

  await ensureAuthSchema(env);
  const auth = createAuth(env);

  let response: Response;
  try {
    response = await auth.handler(request);
  } catch (error) {
    console.error("[handleAuth] auth.handler threw:", error);
    if (url.pathname.includes("/callback/")) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNAUTHORIZED_EMAIL")) {
        return Response.redirect(new URL("/forbidden", url.origin).toString(), 302);
      }
    }
    throw error;
  }

  if (url.pathname.includes("/callback/")) {
    console.log(
      "[handleAuth] callback response:",
      response.status,
      Object.fromEntries(response.headers),
    );
    const clone = response.clone();
    const body = await clone.text().catch(() => "");
    if (body.includes("UNAUTHORIZED_EMAIL")) {
      return Response.redirect(new URL("/forbidden", url.origin).toString(), 302);
    }
  }

  return response;
}
