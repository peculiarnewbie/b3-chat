import { fetchUserRuntimeConfig, getRuntimeEnv, requireSessionUser } from "@g3-chat/server";

export async function handleRuntimeConfig(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  const user = await requireSessionUser(request, env);
  return Response.json(await fetchUserRuntimeConfig(env, user.userId));
}
