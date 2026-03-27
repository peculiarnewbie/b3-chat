import {
  fetchModelsCatalog,
  filterModelsCatalog,
  getRuntimeEnv,
  requireSession,
  syncMutate,
} from "@g3-chat/server";
import { VALUES } from "@g3-chat/domain";

export async function handleModels(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  await requireSession(request, env);
  const cache = (globalThis.caches as CacheStorage & { default: Cache }).default;
  const raw = await fetchModelsCatalog(env, cache);
  const catalog = filterModelsCatalog(raw, env);
  await syncMutate(env, {
    type: "set-value",
    key: VALUES.lastCatalogRefreshAt,
    value: new Date().toISOString(),
  });
  return Response.json(catalog);
}
