import { toolDefinition } from "@tanstack/ai";
import {
  buildMultiSearchContext,
  createSearchRun,
  decodeSearchResultRow,
  type SearchResult,
  type SearchRun,
} from "@b3-chat/domain";
import {
  clampExaResults,
  exaMcpSearchRawText,
  exaSearch,
  ExaSearchError,
  type AppEnv,
} from "@b3-chat/server";

const SEARCH_RESULTS_PER_RUN = 5;
/** Hard cap on searches per assistant turn. Beyond this, we refuse further
 *  searches and tell the model to answer with what it has. This is the
 *  primary defence against "stuck in a search loop" failures with thinking
 *  models that keep reformulating the same question. */
export const MAX_SEARCHES_PER_TURN = 4;
/** Minimum normalized query length. Anything shorter is probably garbage
 *  (the model accidentally sending a single word or an empty string). */
const MIN_QUERY_CHARS = 2;

type SearchGroundingRun = {
  query: string;
  rows?: Array<{ title: string; url: string; snippet: string }>;
  rawText?: string;
};

/**
 * Progress event shared by `exa_web_search` and `web_extract`.
 *
 * `tool` is the discriminator the UI branches on: search and extract both
 * emit stepped activities, and without this field step 1 of extract would
 * collide with step 1 of search in the timeline builder. Existing callers
 * that predate the extract wiring may still omit it — those default to the
 * search chip, which is the behavior we had before.
 */
export type ToolProgressEvent = {
  tool?: "search" | "extract";
  label: string;
  state?: "active" | "completed" | "failed";
  step?: number;
  query?: string;
  detail?: string;
};

/** @deprecated use ToolProgressEvent. Kept as an alias to avoid churn. */
export type SearchProgressEvent = ToolProgressEvent;

type SearchToolState = {
  searchRuns: SearchRun[];
  searchResults: SearchResult[];
};

function summarizeStructuredResults(rows: Array<{ title: string; snippet: string }>) {
  return rows
    .slice(0, 3)
    .map((row) => [row.title, row.snippet].filter(Boolean).join(" - "))
    .filter(Boolean)
    .join(" | ")
    .slice(0, 240);
}

function summarizeRawText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Normalize a query to detect near-duplicates. Lowercases, collapses
 *  whitespace, and strips trivial punctuation so minor reformulations
 *  ("current F1 standings" vs "current f1 standings.") map to the same key. */
function normalizeQueryKey(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Result returned to the LLM for a tool call. Always JSON-serializable.
 * The TanStack AI adapter stringifies this and feeds it back as the tool
 * message, so we want a small, structured shape the model can read.
 *
 * IMPORTANT: we never throw from the tool handler. Throwing would either
 * (a) abort the entire assistant turn, or (b) surface a TanStack
 * "output-error" that the model often fails to recover from — instead we
 * return a structured failure the model can reason about and retry or
 * skip.
 */
type ExaFailureReason =
  | "exa_timeout"
  | "exa_rate_limited"
  | "exa_auth"
  | "exa_network"
  | "exa_http"
  | "exa_empty"
  | "exa_unknown";

type SearchFailureReason =
  | "empty_query"
  | "query_too_short"
  | "duplicate_query"
  | "max_searches_reached"
  | ExaFailureReason;

type SearchToolResult =
  | {
      ok: true;
      query: string;
      resultCount: number;
      context: string;
      disableFurtherToolCalls?: boolean;
      hint?: string;
    }
  | {
      ok: false;
      query: string;
      error: string;
      reason: SearchFailureReason;
      hint: string;
      disableFurtherToolCalls?: boolean;
    };

function classifyExaError(error: unknown): {
  reason: ExaFailureReason;
  message: string;
  hint: string;
} {
  if (error instanceof ExaSearchError) {
    switch (error.reason) {
      case "timeout":
        return {
          reason: "exa_timeout",
          message: error.message,
          hint: "The search service timed out. Try one more time with a shorter, keyword-only query, or proceed without search.",
        };
      case "rate_limited":
        return {
          reason: "exa_rate_limited",
          message: error.message,
          hint: "Rate limited. Do not retry; answer with what you already know and note that live info wasn't available.",
        };
      case "auth":
        return {
          reason: "exa_auth",
          message: error.message,
          hint: "Search is unavailable in this environment. Do not retry; answer without search.",
        };
      case "network":
        return {
          reason: "exa_network",
          message: error.message,
          hint: "Transient network error. You may try one different query, but do not loop.",
        };
      case "http":
        return {
          reason: "exa_http",
          message: error.message,
          hint: "The search service returned an error. Reformulate with different keywords, or proceed without search.",
        };
      case "empty":
        return {
          reason: "exa_empty",
          message: error.message,
          hint: "No content returned. Try a different keyword phrasing.",
        };
      default:
        return {
          reason: "exa_unknown",
          message: error.message,
          hint: "Unknown search error. Do not retry more than once.",
        };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    reason: "exa_unknown",
    message: message.slice(0, 200),
    hint: "Unknown error. Answer with what you have.",
  };
}

export function createExaSearchTool(input: {
  env: AppEnv;
  assistantMessageId: string;
  /**
   * When true, skip the Exa API path even if EXA_API_KEY is configured
   * and use the public MCP endpoint instead. Surfaced as a user-facing
   * setting ("Use free web search") so users on a shared deployment
   * can opt out of the paid API.
   */
  preferFreeExa?: boolean;
  /**
   * Abort signal tied to the assistant turn. When the user presses Stop
   * the turn controller aborts and this signal propagates into the Exa
   * fetch (API or MCP fallback) so the in-flight request tears down
   * instead of running to completion.
   */
  signal?: AbortSignal;
  log?: (event: string, details?: Record<string, unknown>) => void;
  trace?: <A>(name: string, attrs: Record<string, unknown>, run: () => Promise<A>) => Promise<A>;
  onProgress?: (event: SearchProgressEvent) => void | Promise<void>;
  onSearchStateChange?: (state: Readonly<SearchToolState>) => void | Promise<void>;
}) {
  const state: SearchToolState = {
    searchRuns: [],
    searchResults: [],
  };
  /** Map of normalized-query → the first result context for that query.
   *  When the model re-issues an equivalent query, we return the cached
   *  grounding plus a short nudge telling the model to answer rather
   *  than keep searching. This breaks the thinking-model re-ask loop. */
  const queryCache = new Map<string, string>();

  const publishState = async () => {
    await input.onSearchStateChange?.({
      searchRuns: [...state.searchRuns],
      searchResults: [...state.searchResults],
    });
  };
  const trace =
    input.trace ?? ((_: string, __: Record<string, unknown>, run: () => Promise<any>) => run());

  const tool = toolDefinition({
    name: "exa_web_search",
    description: [
      "Run a web search through Exa and receive a grounded block of ranked results (title, URL, snippet).",
      "Use this when external or current information would help answer the user's request.",
      "- If a query returned poor or irrelevant results, reformulate it. Do not re-issue the same or near-identical query — the tool will refuse it.",
      "",
      "Budget: at most a handful of searches per turn. Stop once you have enough to answer, and answer — do not keep searching to be thorough.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query.",
          minLength: 2,
          maxLength: 400,
        },
        numResults: {
          type: "number",
          description:
            "Desired number of results to retrieve, between 3 and 8. Default 5. Use more only when comparing multiple sources.",
          minimum: 3,
          maximum: 8,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  }).server(async (args: any): Promise<SearchToolResult> => {
    // Guard -1: the user already pressed Stop. The model may still emit
    // queued tool_calls from before the abort landed; short-circuit them
    // so we don't fire a web search whose result will be thrown away.
    if (input.signal?.aborted) {
      return {
        ok: false,
        query: typeof args?.query === "string" ? args.query : "",
        error: "Request was cancelled.",
        reason: "exa_unknown",
        hint: "The user cancelled the turn; do not retry.",
      };
    }
    const rawQuery = typeof args?.query === "string" ? args.query : "";
    const query = rawQuery.trim().replace(/\s+/g, " ");
    const numResults = clampExaResults(args?.numResults ?? SEARCH_RESULTS_PER_RUN);

    // Guard 0: empty query.
    if (!query) {
      input.log?.("assistant_turn_tool_search_rejected", {
        assistantMessageId: input.assistantMessageId,
        reason: "empty_query",
      });
      return {
        ok: false,
        query: "",
        error: "Query was empty.",
        reason: "empty_query",
        hint: "Provide a non-empty search query. Do not retry with an empty query.",
      };
    }

    // Guard 1: too-short query (single character, etc.).
    if (query.length < MIN_QUERY_CHARS) {
      return {
        ok: false,
        query,
        error: `Query is too short (${query.length} chars).`,
        reason: "query_too_short",
        hint: "Use a longer search query.",
      };
    }

    // Guard 2: per-turn budget. Absolute ceiling to stop thinking-model loops.
    if (state.searchRuns.length >= MAX_SEARCHES_PER_TURN) {
      input.log?.("assistant_turn_tool_search_rejected", {
        assistantMessageId: input.assistantMessageId,
        reason: "max_searches_reached",
        attempted: query,
        priorRuns: state.searchRuns.length,
      });
      await input.onProgress?.({
        tool: "search",
        label: `Search budget reached (${MAX_SEARCHES_PER_TURN}); answering with existing results`,
        state: "failed",
        step: state.searchRuns.length + 1,
        query,
        detail: "max searches per turn",
      });
      return {
        ok: false,
        query,
        error: `Search budget reached: ${MAX_SEARCHES_PER_TURN} searches already performed this turn.`,
        reason: "max_searches_reached",
        hint: "Do not call exa_web_search again this turn. Answer using the results you already have.",
        disableFurtherToolCalls: true,
      };
    }

    // Guard 3: duplicate / near-duplicate query. Instead of firing another
    // request, return the cached context with a nudge to finalize.
    const queryKey = normalizeQueryKey(query);
    const cached = queryCache.get(queryKey);
    if (cached) {
      input.log?.("assistant_turn_tool_search_deduped", {
        assistantMessageId: input.assistantMessageId,
        query,
        queryKey,
      });
      return {
        ok: false,
        query,
        error: "This query (or a near-duplicate) was already run this turn.",
        reason: "duplicate_query",
        hint: "Do not repeat the same query. Answer using the prior results, or search a meaningfully different angle.",
      };
    }

    return trace("assistant.search.prepare", { query, numResults }, async () => {
      const step = state.searchRuns.length + 1;
      await input.onProgress?.({
        tool: "search",
        label: `Searching the web for "${query}"`,
        state: "active",
        step,
        query,
      });

      return trace("assistant.search.run", { query, step, numResults }, async () => {
        try {
          let groundingRun: SearchGroundingRun;
          let context: string;
          let resultCount = 0;

          if (input.env.EXA_API_KEY && !input.preferFreeExa) {
            const runRows = (await exaSearch(input.env, query, numResults, input.signal)).map(
              (row) =>
                decodeSearchResultRow({
                  ...row,
                  searchRunId: "",
                  messageId: input.assistantMessageId,
                }),
            );
            const run = createSearchRun({
              messageId: input.assistantMessageId,
              query,
              status: "completed",
              step,
              numResults,
              resultCount: runRows.length,
              previewText: summarizeStructuredResults(runRows),
              mode: "api",
            });
            const normalizedRows = runRows.map((row) =>
              decodeSearchResultRow({
                ...row,
                searchRunId: run.id,
                messageId: input.assistantMessageId,
              }),
            );

            state.searchRuns.push(run);
            state.searchResults.push(...normalizedRows);
            resultCount = normalizedRows.length;
            groundingRun = {
              query,
              rows: normalizedRows.map((row) => ({
                title: row.title,
                url: row.url,
                snippet: row.snippet,
              })),
            };

            input.log?.("assistant_turn_tool_search_success", {
              assistantMessageId: input.assistantMessageId,
              step,
              query,
              resultCount: normalizedRows.length,
              mode: "exa_api",
              previewText: run.previewText,
            });
            await input.onProgress?.({
              tool: "search",
              label:
                normalizedRows.length > 0
                  ? `Found ${normalizedRows.length} result${normalizedRows.length === 1 ? "" : "s"} for "${query}"`
                  : `No results for "${query}"`,
              state: "completed",
              step,
              query,
              detail: run.previewText || undefined,
            });
          } else {
            const rawText = await exaMcpSearchRawText(query, numResults, input.signal);
            const run = createSearchRun({
              messageId: input.assistantMessageId,
              query,
              status: "completed",
              step,
              numResults,
              resultCount: 0,
              previewText: summarizeRawText(rawText),
              mode: "mcp",
            });

            state.searchRuns.push(run);
            resultCount = rawText ? 1 : 0;
            groundingRun = {
              query,
              rawText,
            };

            input.log?.("assistant_turn_tool_search_success", {
              assistantMessageId: input.assistantMessageId,
              step,
              query,
              resultCount: 0,
              mode: "exa_mcp",
              previewText: run.previewText,
            });
            await input.onProgress?.({
              tool: "search",
              label: `Search finished for "${query}"`,
              state: "completed",
              step,
              query,
              detail: run.previewText || undefined,
            });
          }

          context = buildMultiSearchContext({ runs: [groundingRun] });
          queryCache.set(queryKey, context);
          await publishState();
          const budgetExhausted = state.searchRuns.length >= MAX_SEARCHES_PER_TURN;
          return {
            ok: true,
            query,
            resultCount,
            context,
            ...(budgetExhausted
              ? {
                  disableFurtherToolCalls: true,
                  hint: "Search budget is exhausted. Do not call tools again; answer using the search results already provided.",
                }
              : {}),
          } satisfies SearchToolResult;
        } catch (error) {
          const { reason, message, hint } = classifyExaError(error);
          // If the user pressed Stop mid-search, the cancel handler already
          // drove the UI into the cancelled state. Keep the run row so the
          // Searching chip doesn't stay "active", but suppress the "Search
          // failed for X" activity chip — that would lie about what
          // happened.
          const cancelled = Boolean(input.signal?.aborted);
          state.searchRuns.push(
            createSearchRun({
              messageId: input.assistantMessageId,
              query,
              status: "failed",
              step,
              numResults,
              errorMessage: cancelled ? "Cancelled" : message,
              mode: input.env.EXA_API_KEY && !input.preferFreeExa ? "api" : "mcp",
            }),
          );
          await publishState();
          input.log?.("assistant_turn_tool_search_error", {
            assistantMessageId: input.assistantMessageId,
            step,
            query,
            error: message,
            reason,
            cancelled,
          });
          if (!cancelled) {
            await input.onProgress?.({
              tool: "search",
              label: `Search failed for "${query}"`,
              state: "failed",
              step,
              query,
              detail: message,
            });
          }
          // Return a structured failure — do NOT throw. Throwing aborts the
          // turn; we want the model to see the failure, adjust, and
          // continue (or decide to answer without search).
          const budgetExhausted = state.searchRuns.length >= MAX_SEARCHES_PER_TURN;
          return {
            ok: false,
            query,
            error: cancelled ? "Request was cancelled." : message,
            reason: cancelled ? "exa_unknown" : reason,
            hint: cancelled ? "The user cancelled the turn; do not retry." : hint,
            ...(budgetExhausted ? { disableFurtherToolCalls: true } : {}),
          } satisfies SearchToolResult;
        }
      });
    });
  });

  return {
    tool,
    state,
  };
}
