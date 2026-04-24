import { getRuntimeEnv, getSession } from "@b3-chat/server";
import { runApiTrace } from "../server/api-tracing";

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

export async function handleBootstrap(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  return runApiTrace({
    scope: "bootstrap-api",
    name: "bootstrap.fetch",
    kind: "io",
    env,
    attrs: {
      method: request.method,
      path: new URL(request.url).pathname,
    },
    run: async () => {
      const session = await getSession(request, env);
      const headers = new Headers({ "content-type": "application/json" });

      if (!session) return new Response(JSON.stringify({ session: null }), { headers });

      if (session.tokens) {
        headers.append(
          "Set-Cookie",
          serializeCookie("auth_access_token", session.tokens.access, {
            maxAge: session.tokens.expiresIn,
          }),
        );
        headers.append(
          "Set-Cookie",
          serializeCookie("auth_refresh_token", session.tokens.refresh, {
            maxAge: 60 * 60 * 24 * 365,
          }),
        );
      }

      return new Response(
        JSON.stringify({
          session: { user: session.user },
        }),
        { headers },
      );
    },
  });
}
