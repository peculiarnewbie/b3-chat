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
const MAX_SEARCHES_PER_TURN = 4;
/** Minimum normalized query length. Anything shorter is probably garbage
 *  (the model accidentally sending a single word or an empty string). */
const MIN_QUERY_CHARS = 2;

type SearchGroundingRun = {
  query: string;
  rows?: Array<{ title: string; url: string; snippet: string }>;
  rawText?: string;
};

export type SearchProgressEvent = {
  label: string;
  state?: "active" | "completed" | "failed";
  step?: number;
  query?: string;
  detail?: string;
};

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
    }
  | {
      ok: false;
      query: string;
      error: string;
      reason: SearchFailureReason;
      hint: string;
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
      "Use this whenever the answer depends on facts that may have changed since training, anything user-specific or organization-specific, recent events, live data (prices, scores, standings), breaking news, release notes, or any claim the user would expect you to verify.",
      "",
      "Query style (this matters a lot):",
      "- Write keyword-dense queries, not full natural-language questions. Good: `Oscar Piastri 2026 F1 WDC standings`. Bad: `who is currently leading the 2026 Formula 1 World Drivers Championship right now`.",
      "- Include concrete entities: names, versions, years, product/repo names, locations. These are what Exa indexes against.",
      "- When the user's question has multiple facets (e.g. comparison, multi-topic), issue separate focused searches rather than one long combined query.",
      "- Include the current year for time-sensitive info so you don't get stale results.",
      "- If a query returned poor or irrelevant results, reformulate with *different* keywords. Do not re-issue the same or near-identical query — the tool will refuse it.",
      "",
      "Budget: at most a handful of searches per turn. Stop once you have enough to answer, and answer — do not keep searching to be thorough.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Keyword-dense search query (typically 3–10 terms). Prefer concrete entities over natural-language phrasing.",
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
        hint: "Provide a non-empty keyword-dense query. Do not retry with an empty query.",
      };
    }

    // Guard 1: too-short query (single character, etc.).
    if (query.length < MIN_QUERY_CHARS) {
      return {
        ok: false,
        query,
        error: `Query is too short (${query.length} chars).`,
        reason: "query_too_short",
        hint: "Use a keyword-dense query with at least a few concrete terms.",
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

          if (input.env.EXA_API_KEY) {
            const runRows = (await exaSearch(input.env, query, numResults)).map((row) =>
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
            const rawText = await exaMcpSearchRawText(query, numResults);
            const run = createSearchRun({
              messageId: input.assistantMessageId,
              query,
              status: "completed",
              step,
              numResults,
              resultCount: 0,
              previewText: summarizeRawText(rawText),
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
          return {
            ok: true,
            query,
            resultCount,
            context,
          } satisfies SearchToolResult;
        } catch (error) {
          const { reason, message, hint } = classifyExaError(error);
          state.searchRuns.push(
            createSearchRun({
              messageId: input.assistantMessageId,
              query,
              status: "failed",
              step,
              numResults,
              errorMessage: message,
            }),
          );
          await publishState();
          input.log?.("assistant_turn_tool_search_error", {
            assistantMessageId: input.assistantMessageId,
            step,
            query,
            error: message,
            reason,
          });
          await input.onProgress?.({
            label: `Search failed for "${query}"`,
            state: "failed",
            step,
            query,
            detail: message,
          });
          // Return a structured failure — do NOT throw. Throwing aborts the
          // turn; we want the model to see the failure, adjust, and
          // continue (or decide to answer without search).
          return {
            ok: false,
            query,
            error: message,
            reason,
            hint,
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
