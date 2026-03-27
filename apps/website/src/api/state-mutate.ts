import { getRuntimeEnv, requireSession, syncMutate } from "@g3-chat/server";
import type { SyncMutation } from "@g3-chat/domain";

export async function handleStateMutate(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  await requireSession(request, env);
  const mutation = (await request.json()) as SyncMutation;
  const snapshot = await syncMutate(env, mutation);
  return Response.json(snapshot);
}
