import { ensureSeedData, getRuntimeEnv, getSession } from "@g3-chat/server";

export async function handleSession(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  const session = await getSession(request, env);
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    await ensureSeedData(env);
  } catch (error) {
    console.error("[handleSession] failed to seed sync store:", error);
  }
  return Response.json(session);
}
