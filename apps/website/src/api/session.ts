import { fetchUserRuntimeConfig, getRuntimeEnv, requireSessionUser } from "@g3-chat/server";

export async function handleSession(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  const user = await requireSessionUser(request, env);
  const runtimeConfig = await fetchUserRuntimeConfig(env, user.userId);
  return Response.json({
    user: {
      id: user.userId,
      email: user.email,
      name: user.name,
      image: user.image,
    },
    runtimeConfig,
  });
}
