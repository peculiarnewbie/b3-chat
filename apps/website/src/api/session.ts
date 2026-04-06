import { getRuntimeEnv, getSession } from "@b3-chat/server";

export async function handleSession(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  const session = await getSession(request, env);
  if (!session) return new Response("Unauthorized", { status: 401 });
  return Response.json(session);
}
