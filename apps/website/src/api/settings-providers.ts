import {
  getRuntimeEnv,
  requireSessionUser,
  saveUserProviderSettings,
  fetchUserProviderSettings,
} from "@g3-chat/server";

export async function handleProviderSettings(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  const user = await requireSessionUser(request, env);

  if (request.method === "GET") {
    return Response.json(await fetchUserProviderSettings(env, user.userId));
  }

  if (request.method === "PUT") {
    const input = (await request.json().catch(() => ({}))) as {
      opencodeApiKey?: string | null;
      exaApiKey?: string | null;
    };
    return Response.json(await saveUserProviderSettings(env, user.userId, input));
  }

  return new Response("Method not allowed", { status: 405 });
}
