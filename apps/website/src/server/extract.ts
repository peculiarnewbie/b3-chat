import { toolDefinition } from "@tanstack/ai";
import {
  BrowserRenderError,
  cloudflareBrowserMarkdown,
  normalizeExtractUrl,
  truncateExtractedMarkdown,
  type AppEnv,
} from "@b3-chat/server";
import type { SearchProgressEvent } from "./search";

/**
 * Cap on extract calls per assistant turn. The limit is about quality, not
 * cost — Cloudflare Browser Rendering is effectively free on Paid
 * (~fractions of a cent per page, well within the included browser-hour
 * budget), while Exa search calls are pay-per-query. The real reason to cap
 * this is to stop the model from doom-extracting link after link instead of
 * answering. Five gives it plenty of room to follow up on a search without
 * going off the rails. */
const MAX_EXTRACTS_PER_TURN = 5;

type ExtractToolResult =
  | {
      ok: true;
      url: string;
      /** Clean markdown extracted from the page. May be truncated. */
      content: string;
      truncated: boolean;
      originalLength: number;
    }
  | {
      ok: false;
      url: string;
      error: string;
      reason:
        | "invalid_url"
        | "duplicate_url"
        | "max_extracts_reached"
        | "not_configured"
        | "extract_timeout"
        | "extract_rate_limited"
        | "extract_auth"
        | "extract_network"
        | "extract_http"
        | "extract_empty"
        | "extract_unknown";
      hint: string;
    };

function classifyRenderError(error: unknown): {
  reason: Exclude<
    (ExtractToolResult & { ok: false })["reason"],
    "invalid_url" | "duplicate_url" | "max_extracts_reached"
  >;
  message: string;
  hint: string;
} {
  if (error instanceof BrowserRenderError) {
    switch (error.reason) {
      case "not_configured":
        return {
          reason: "not_configured",
          message: error.message,
          hint: "The extract tool is not configured in this deployment. Answer without extracting.",
        };
      case "timeout":
        return {
          reason: "extract_timeout",
          message: error.message,
          hint: "The page took too long to render. Try one different URL, or answer with what you have from the search results.",
        };
      case "rate_limited":
        return {
          reason: "extract_rate_limited",
          message: error.message,
          hint: "Rate limited by Browser Rendering. Do not retry; answer with existing context.",
        };
      case "auth":
        return {
          reason: "extract_auth",
          message: error.message,
          hint: "Browser Rendering credentials rejected. Do not retry; answer without extracting.",
        };
      case "network":
        return {
          reason: "extract_network",
          message: error.message,
          hint: "Transient network error. You may try one different URL.",
        };
      case "http":
        return {
          reason: "extract_http",
          message: error.message,
          hint: "The target page returned an error status. Try a different URL, or answer with existing context.",
        };
      case "empty":
        return {
          reason: "extract_empty",
          message: error.message,
          hint: "The page rendered to empty content. Try a different URL or fall back to search snippets.",
        };
      case "invalid_url":
        return {
          reason: "extract_http",
          message: error.message,
          hint: "The URL is malformed. Pass a full http(s) URL.",
        };
      default:
        return {
          reason: "extract_unknown",
          message: error.message,
          hint: "Unknown Browser Rendering error. Do not retry more than once.",
        };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    reason: "extract_unknown",
    message: message.slice(0, 200),
    hint: "Unknown error. Answer with what you have.",
  };
}

function normalizeUrlKey(url: string): string {
  const parsed = normalizeExtractUrl(url);
  if (!parsed) return url.trim().toLowerCase();
  // Collapse near-duplicates: ignore trailing slash, hash, and common utm_*
  // params so the model can't blow budget by reformulating the same link.
  // Snapshot keys before mutating since URLSearchParams iterators are live.
  const clean = new URL(parsed.toString());
  const keysToStrip = Array.from(clean.searchParams.keys()).filter(
    (key) => key.startsWith("utm_") || key === "ref" || key === "fbclid" || key === "gclid",
  );
  for (const key of keysToStrip) {
    clean.searchParams.delete(key);
  }
  clean.hash = "";
  let pathname = clean.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  clean.pathname = pathname;
  return clean.toString().toLowerCase();
}

type ExtractToolState = {
  extractRuns: Array<{
    url: string;
    status: "completed" | "failed";
    step: number;
    errorMessage?: string | null;
    originalLength?: number;
    truncated?: boolean;
  }>;
};

export function createBrowserExtractTool(input: {
  env: AppEnv;
  assistantMessageId: string;
  log?: (event: string, details?: Record<string, unknown>) => void;
  trace?: <A>(name: string, attrs: Record<string, unknown>, run: () => Promise<A>) => Promise<A>;
  onProgress?: (event: SearchProgressEvent) => void | Promise<void>;
  /**
   * Injection point. Defaults to `cloudflareBrowserMarkdown`, which hits
   * the Browser Rendering binding via puppeteer. Tests pass a fake so they
   * don't need to spin up a real Chromium session.
   */
  extract?: (env: AppEnv, url: string) => Promise<string>;
}) {
  const state: ExtractToolState = { extractRuns: [] };
  const urlCache = new Map<string, ExtractToolResult & { ok: true }>();
  const trace =
    input.trace ?? ((_: string, __: Record<string, unknown>, run: () => Promise<any>) => run());
  const extract = input.extract ?? cloudflareBrowserMarkdown;

  const tool = toolDefinition({
    name: "web_extract",
    description: [
      "Fetch a specific web page and return its full content as clean markdown via Cloudflare Browser Rendering.",
      "Use this when you already have a URL and need the full text of the page — for example, after exa_web_search surfaced a promising link, when the user pasted a URL, or when a snippet from search is clearly insufficient.",
      "",
      "Do NOT use this tool to discover URLs; use exa_web_search first if you don't already have one.",
      "Do NOT extract homepage URLs hoping to find a specific article; pass the actual article URL.",
      "",
      "Budget: at most a few extracts per turn. The response is capped to the first ~12k characters; do not re-extract the same URL.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Absolute http(s) URL of the page to extract. Must be a specific article/document URL, not a bare domain.",
          minLength: 4,
          maxLength: 2048,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  }).server(async (args: any): Promise<ExtractToolResult> => {
    const rawUrl = typeof args?.url === "string" ? args.url : "";
    const parsed = normalizeExtractUrl(rawUrl);

    // Guard 0: invalid URL.
    if (!parsed) {
      input.log?.("assistant_turn_tool_extract_rejected", {
        assistantMessageId: input.assistantMessageId,
        reason: "invalid_url",
        raw: rawUrl.slice(0, 200),
      });
      return {
        ok: false,
        url: rawUrl,
        error: "URL is not a valid http(s) URL.",
        reason: "invalid_url",
        hint: "Pass a complete URL including the scheme, e.g. https://example.com/article.",
      };
    }
    const url = parsed.toString();

    // Guard 1: per-turn budget.
    if (state.extractRuns.length >= MAX_EXTRACTS_PER_TURN) {
      input.log?.("assistant_turn_tool_extract_rejected", {
        assistantMessageId: input.assistantMessageId,
        reason: "max_extracts_reached",
        url,
        priorRuns: state.extractRuns.length,
      });
      await input.onProgress?.({
        label: `Extract budget reached (${MAX_EXTRACTS_PER_TURN}); answering with existing content`,
        state: "failed",
        step: state.extractRuns.length + 1,
        detail: "max extracts per turn",
      });
      return {
        ok: false,
        url,
        error: `Extract budget reached: ${MAX_EXTRACTS_PER_TURN} pages already fetched this turn.`,
        reason: "max_extracts_reached",
        hint: "Do not call web_extract again this turn. Answer using the content you already have.",
      };
    }

    // Guard 2: duplicate URL. Return cached content rather than re-fetching.
    const urlKey = normalizeUrlKey(url);
    const cached = urlCache.get(urlKey);
    if (cached) {
      input.log?.("assistant_turn_tool_extract_deduped", {
        assistantMessageId: input.assistantMessageId,
        url,
        urlKey,
      });
      return {
        ok: false,
        url,
        error: "This URL (or a near-duplicate) was already extracted this turn.",
        reason: "duplicate_url",
        hint: "Do not re-extract the same URL. Use the previous content, or extract a different page.",
      };
    }

    return trace("assistant.extract.prepare", { url }, async () => {
      const step = state.extractRuns.length + 1;
      await input.onProgress?.({
        label: `Reading ${safeHost(url) || url}`,
        state: "active",
        step,
      });

      return trace("assistant.extract.run", { url, step }, async () => {
        try {
          const markdown = await extract(input.env, url);
          const { text, truncated, originalLength } = truncateExtractedMarkdown(markdown);
          state.extractRuns.push({
            url,
            status: "completed",
            step,
            originalLength,
            truncated,
          });
          urlCache.set(urlKey, {
            ok: true,
            url,
            content: text,
            truncated,
            originalLength,
          });
          input.log?.("assistant_turn_tool_extract_success", {
            assistantMessageId: input.assistantMessageId,
            step,
            url,
            chars: text.length,
            originalLength,
            truncated,
          });
          await input.onProgress?.({
            label: truncated
              ? `Read ${safeHost(url) || url} (${originalLength.toLocaleString()} chars, truncated)`
              : `Read ${safeHost(url) || url} (${originalLength.toLocaleString()} chars)`,
            state: "completed",
            step,
          });
          return {
            ok: true,
            url,
            content: text,
            truncated,
            originalLength,
          } satisfies ExtractToolResult;
        } catch (error) {
          const { reason, message, hint } = classifyRenderError(error);
          state.extractRuns.push({
            url,
            status: "failed",
            step,
            errorMessage: message,
          });
          input.log?.("assistant_turn_tool_extract_error", {
            assistantMessageId: input.assistantMessageId,
            step,
            url,
            error: message,
            reason,
          });
          await input.onProgress?.({
            label: `Failed to read ${safeHost(url) || url}`,
            state: "failed",
            step,
            detail: message,
          });
          return {
            ok: false,
            url,
            error: message,
            reason,
            hint,
          } satisfies ExtractToolResult;
        }
      });
    });
  });

  return {
    tool,
    state,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
