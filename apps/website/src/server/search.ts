import { toolDefinition } from "@tanstack/ai";
import {
  buildMultiSearchContext,
  createSearchRun,
  decodeSearchResultRow,
  type SearchResult,
  type SearchRun,
} from "@b3-chat/domain";
import { clampExaResults, exaMcpSearchRawText, exaSearch, type AppEnv } from "@b3-chat/server";

const SEARCH_RESULTS_PER_RUN = 5;

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
    description:
      "Search the public web for current or external information. Use this when the user asks for recent, live, or verifiable information, or when the answer depends on sources outside the conversation.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A focused web search query rewritten for the information you need to find.",
        },
        numResults: {
          type: "number",
          description: "Desired number of results to retrieve, between 3 and 8.",
          minimum: 3,
          maximum: 8,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  }).server(async (args: any) => {
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    const numResults = clampExaResults(args?.numResults ?? SEARCH_RESULTS_PER_RUN);
    return trace("assistant.search.prepare", { query, numResults }, async () => {
      if (!query) {
        throw new Error("Search query is required");
      }

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
              label: `Found ${normalizedRows.length} result${normalizedRows.length === 1 ? "" : "s"} for "${query}"`,
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

          await publishState();
          return buildMultiSearchContext({
            runs: [groundingRun],
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          state.searchRuns.push(
            createSearchRun({
              messageId: input.assistantMessageId,
              query,
              status: "failed",
              step,
              numResults,
              errorMessage,
            }),
          );
          await publishState();
          input.log?.("assistant_turn_tool_search_error", {
            assistantMessageId: input.assistantMessageId,
            step,
            query,
            error: errorMessage,
          });
          await input.onProgress?.({
            label: `Search failed for "${query}"`,
            state: "failed",
            step,
            query,
            detail: errorMessage,
          });
          throw error instanceof Error ? error : new Error(errorMessage);
        }
      });
    });
  });

  return {
    tool,
    state,
  };
}
