import { createAuth, ensureAuthSchema, getRuntimeEnv } from "@g3-chat/server";

export async function handleAuth(request: Request): Promise<Response> {
  const env = getRuntimeEnv();

  await ensureAuthSchema(env);
  const auth = createAuth(env);

  try {
    return await auth.handler(request);
  } catch (error) {
    console.error("[handleAuth] auth.handler threw:", error);
    throw error;
  }
}
