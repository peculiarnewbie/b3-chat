import {
  fetchUserRuntimeConfig,
  fetchModelsCatalog,
  filterModelsCatalog,
  getRuntimeEnv,
  requireSessionUser,
} from "@g3-chat/server";

export async function handleModels(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  const user = await requireSessionUser(request, env);
  const cache = (globalThis.caches as CacheStorage & { default: Cache }).default;
  const raw = await fetchModelsCatalog(env, cache);
  const runtimeConfig = await fetchUserRuntimeConfig(env, user.userId);
  return Response.json({
    ...filterModelsCatalog(raw, env),
    runtimeConfig,
  });
}
