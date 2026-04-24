import { issuer } from "@openauthjs/openauth";
import { GoogleOidcProvider } from "@openauthjs/openauth/provider/google";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import { subjects } from "./subjects.js";
import type { AppEnv } from "@b3-chat/effect";
import { normalizeEmail } from "../index.js";

export function createAuthIssuer(env: AppEnv) {
  return issuer({
    providers: {
      google: GoogleOidcProvider({
        clientID: env.GOOGLE_CLIENT_ID,
        scopes: ["openid", "email", "profile"],
      }),
    },
    subjects,
    storage: CloudflareStorage({ namespace: env.OPENAUTH_STORAGE as any }),
    ttl: {
      access: 60 * 60 * 24 * 365,
      refresh: 60 * 60 * 24 * 365,
    },
    success: async (ctx, value) => {
      if (value.provider === "google") {
        const email =
          typeof (value.id as Record<string, unknown> | undefined)?.email === "string"
            ? ((value.id as Record<string, unknown>).email as string)
            : undefined;
        if (!email) {
          return new Response("No email from Google", { status: 400 });
        }
        if (normalizeEmail(email) !== normalizeEmail(env.OWNER_EMAIL)) {
          return Response.redirect(`${env.APP_PUBLIC_URL}/forbidden`, 302);
        }
        return ctx.subject("user", { email });
      }
      return new Response("Invalid provider", { status: 400 });
    },
  });
}
