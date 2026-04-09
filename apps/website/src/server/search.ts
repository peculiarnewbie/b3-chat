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
  decideSearchQuery,
  exaMcpSearchRawText,
  exaSearch,
  inferForcedSearchQuery,
  type AppEnv,
  type SearchQueryDecision,
} from "@b3-chat/server";
const SEARCH_RESULTS_PER_RUN = 5;

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

export type SearchProgressEvent = {
  label: string;
  state?: "active" | "completed" | "failed";
  step?: number;
  query?: string;
  detail?: string;
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

function normalizePromptText(text: string) {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function isSearchCapabilityQuestion(promptText: string) {
  const normalized = normalizePromptText(promptText);
  if (!normalized) return false;

  return [
    /^(can|could|would|will)\s+you\s+(do\s+)?(a\s+)?(web\s+)?(search|searches|browse|look up)(\s+the\s+web)?(\s+for\s+me)?\??$/,
    /^(do|does)\s+you\s+(have|support|use)\s+(web\s+)?(search|searches|browsing)(\s+capabilit(?:y|ies))?\??$/,
    /^are\s+you\s+(able|capable)\s+to\s+(search|browse|look up)(\s+the\s+web)?\??$/,
  ].some((pattern) => pattern.test(normalized));
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
  onProgress?: (event: SearchProgressEvent) => void | Promise<void>;
}): Promise<PreparedAssistantSearch> {
  if (!input.enabled || !input.promptText.trim()) {
    return {
      searchRuns: [],
      searchResults: [],
      searchContext: "",
    };
  }

  if (isSearchCapabilityQuestion(input.promptText)) {
    input.log?.("assistant_turn_search_skipped_capability_question", {
      assistantMessageId: input.assistantMessageId,
      promptText: input.promptText,
    });
    return {
      searchRuns: [],
      searchResults: [],
      searchContext: "",
    };
  }

  const searchRuns: SearchRun[] = [];
  const searchResults: SearchResult[] = [];
  const groundingRuns: SearchGroundingRun[] = [];
  input.log?.("assistant_turn_search_context", {
    assistantMessageId: input.assistantMessageId,
    promptText: input.promptText,
    enabled: input.enabled,
    messageCount: input.messages.length,
    recentUserMessages: input.messages
      .filter((message) => message.role === "user")
      .slice(-6)
      .map((message) => ({
        text: (message.text ?? "").slice(0, 160),
        status: message.status,
      })),
  });
  await input.onProgress?.({
    label: "Planning search query",
    state: "active",
    step: 1,
  });
  const planningContext = buildSearchPlanningContext({
    promptText: input.promptText,
    messages: input.messages,
    systemPrompt: input.systemPrompt,
  });

  let decision: SearchQueryDecision;
  try {
    decision = await decideSearchQuery(input.env, {
      modelId: input.modelId,
      planningContext,
    });
  } catch (error) {
    input.log?.("assistant_turn_search_planner_error", {
      assistantMessageId: input.assistantMessageId,
      error: String(error),
    });
    const fallbackQuery = inferForcedSearchQuery(input.promptText);
    decision = {
      shouldSearch: Boolean(fallbackQuery),
      query: fallbackQuery ?? "",
    };
  }

  input.log?.("assistant_turn_search_decision", {
    assistantMessageId: input.assistantMessageId,
    shouldSearch: decision.shouldSearch,
    query: decision.query,
  });

  if (!decision.shouldSearch || !decision.query.trim()) {
    await input.onProgress?.({
      label: "Answering from current context",
      state: "completed",
      step: 1,
    });
    return {
      searchRuns,
      searchResults,
      searchContext: "",
    };
  }

  const query = decision.query.trim();
  await input.onProgress?.({
    label: `Searching the web for "${query}"`,
    state: "active",
    step: 1,
    query,
  });

  try {
    if (input.env.EXA_API_KEY) {
      const runRows = (await exaSearch(input.env, query, SEARCH_RESULTS_PER_RUN)).map((row) =>
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
        step: 1,
        numResults: SEARCH_RESULTS_PER_RUN,
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
        step: 1,
        query,
        resultCount: normalizedRows.length,
        mode: "exa_api",
        previewText: run.previewText,
      });
      await input.onProgress?.({
        label: `Found ${normalizedRows.length} result${normalizedRows.length === 1 ? "" : "s"} for "${query}"`,
        state: "completed",
        step: 1,
        query,
        detail: run.previewText || undefined,
      });
    } else {
      const rawText = await exaMcpSearchRawText(query, SEARCH_RESULTS_PER_RUN);
      const run = createSearchRun({
        messageId: input.assistantMessageId,
        query,
        status: "completed",
        step: 1,
        numResults: SEARCH_RESULTS_PER_RUN,
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
        step: 1,
        query,
        resultCount: 0,
        mode: "exa_mcp",
        previewText: run.previewText,
      });
      await input.onProgress?.({
        label: `Search finished for "${query}"`,
        state: "completed",
        step: 1,
        query,
        detail: run.previewText || undefined,
      });
    }
  } catch (error) {
    input.log?.("assistant_turn_search_execution_error", {
      assistantMessageId: input.assistantMessageId,
      step: 1,
      query,
      error: String(error),
    });
    const errorMessage = error instanceof Error ? error.message : String(error);
    searchRuns.push(
      createSearchRun({
        messageId: input.assistantMessageId,
        query,
        status: "failed",
        step: 1,
        numResults: SEARCH_RESULTS_PER_RUN,
        errorMessage,
      }),
    );
    await input.onProgress?.({
      label: `Search failed for "${query}"`,
      state: "failed",
      step: 1,
      query,
      detail: errorMessage,
    });
  }

  return {
    searchRuns,
    searchResults,
    searchContext: buildMultiSearchContext({
      runs: groundingRuns,
    }),
  };
}
