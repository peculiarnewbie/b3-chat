import {
  fetchModelsCatalog,
  filterModelsCatalog,
  getRuntimeEnv,
  requireSession,
} from "@g3-chat/server";

export async function handleModels(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  await requireSession(request, env);
  const cache = (globalThis.caches as CacheStorage & { default: Cache }).default;
  const raw = await fetchModelsCatalog(env, cache);
  return Response.json(filterModelsCatalog(raw, env));
}
