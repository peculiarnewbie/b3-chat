import {
  buildMultiSearchContext,
  buildSearchPlanningContext,
  createSearchRun,
  decodeSearchResultRow,
  type Message,
  type SearchResult,
  type SearchRun,
} from "@b3-chat/domain";
import {
  decideSearchStep,
  exaMcpSearchRawText,
  exaSearch,
  inferForcedSearchQuery,
  type AppEnv,
  type SearchStepDecision,
} from "@b3-chat/server";

const MAX_SEARCH_STEPS = 2;

type SearchGroundingRun = {
  query: string;
  rows?: Array<{ title: string; url: string; snippet: string }>;
  rawText?: string;
};

export type PreparedAssistantSearch = {
  searchRuns: SearchRun[];
  searchResults: SearchResult[];
  searchContext: string;
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

function stableQueryKey(query: string) {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function noSearchDecision(): SearchStepDecision {
  return {
    action: "answer",
    summary: "",
    query: "",
    numResults: 0,
  };
}

function forcedSearchDecision(promptText: string): SearchStepDecision | null {
  const query = inferForcedSearchQuery(promptText);
  if (!query) return null;
  return {
    action: "search",
    summary: "Explicit lookup or current external information request",
    query,
    numResults: 5,
  };
}

export async function prepareAssistantSearch(input: {
  env: AppEnv;
  assistantMessageId: string;
  modelId: string;
  promptText: string;
  messages: Message[];
  systemPrompt?: string | null;
  enabled: boolean;
  log?: (event: string, details?: Record<string, unknown>) => void;
}): Promise<PreparedAssistantSearch> {
  if (!input.enabled || !input.promptText.trim()) {
    return {
      searchRuns: [],
      searchResults: [],
      searchContext: "",
    };
  }

  const searchRuns: SearchRun[] = [];
  const searchResults: SearchResult[] = [];
  const groundingRuns: SearchGroundingRun[] = [];
  const attemptedQueries = new Set<string>();

  for (let step = 1; step <= MAX_SEARCH_STEPS; step += 1) {
    const planningContext = buildSearchPlanningContext({
      promptText: input.promptText,
      messages: input.messages,
      systemPrompt: input.systemPrompt,
      priorSearches: searchRuns.map((run) => ({
        query: run.query,
        resultCount: run.resultCount,
        summary: run.previewText,
        status: run.status,
      })),
    });

    let decision: SearchStepDecision;
    try {
      decision = await decideSearchStep(input.env, {
        modelId: input.modelId,
        planningContext,
      });
    } catch (error) {
      input.log?.("assistant_turn_search_step_error", {
        assistantMessageId: input.assistantMessageId,
        step,
        error: String(error),
      });
      decision = noSearchDecision();
    }

    const forcedDecision = searchRuns.length === 0 ? forcedSearchDecision(input.promptText) : null;
    if (forcedDecision && decision.action !== "search") {
      input.log?.("assistant_turn_search_forced", {
        assistantMessageId: input.assistantMessageId,
        step,
        originalAction: decision.action,
        originalQuery: decision.query,
        forcedQuery: forcedDecision.query,
      });
      decision = forcedDecision;
    }

    input.log?.("assistant_turn_search_step", {
      assistantMessageId: input.assistantMessageId,
      step,
      action: decision.action,
      summary: decision.summary,
      query: decision.query,
      numResults: decision.numResults,
    });

    if (decision.action !== "search" || !decision.query.trim()) break;

    const query = decision.query.trim();
    const queryKey = stableQueryKey(query);
    if (attemptedQueries.has(queryKey)) {
      input.log?.("assistant_turn_search_duplicate_query_skipped", {
        assistantMessageId: input.assistantMessageId,
        step,
        query,
      });
      break;
    }
    attemptedQueries.add(queryKey);

    try {
      if (input.env.EXA_API_KEY) {
        const runRows = (await exaSearch(input.env, query, decision.numResults)).map((row) =>
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
          numResults: decision.numResults,
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

        searchRuns.push(run);
        searchResults.push(...normalizedRows);
        groundingRuns.push({
          query,
          rows: normalizedRows.map((row) => ({
            title: row.title,
            url: row.url,
            snippet: row.snippet,
          })),
        });
        input.log?.("assistant_turn_search_execution_success", {
          assistantMessageId: input.assistantMessageId,
          step,
          query,
          resultCount: normalizedRows.length,
          mode: "exa_api",
          previewText: run.previewText,
        });
        continue;
      }

      const rawText = await exaMcpSearchRawText(query, decision.numResults);
      const run = createSearchRun({
        messageId: input.assistantMessageId,
        query,
        status: "completed",
        step,
        numResults: decision.numResults,
        resultCount: 0,
        previewText: summarizeRawText(rawText),
      });
      searchRuns.push(run);
      groundingRuns.push({
        query,
        rawText,
      });
      input.log?.("assistant_turn_search_execution_success", {
        assistantMessageId: input.assistantMessageId,
        step,
        query,
        resultCount: 0,
        mode: "exa_mcp",
        previewText: run.previewText,
      });
    } catch (error) {
      input.log?.("assistant_turn_search_execution_error", {
        assistantMessageId: input.assistantMessageId,
        step,
        query,
        error: String(error),
      });
      searchRuns.push(
        createSearchRun({
          messageId: input.assistantMessageId,
          query,
          status: "failed",
          step,
          numResults: decision.numResults,
          errorMessage: String(error),
        }),
      );
      break;
    }
  }

  return {
    searchRuns,
    searchResults,
    searchContext: buildMultiSearchContext({
      runs: groundingRuns,
    }),
  };
}
