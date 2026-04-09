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

function stableQueryKey(query: string) {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
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

function isAmbiguousRealtimeFollowUp(promptText: string) {
  const normalized = normalizePromptText(promptText);
  if (!normalized) return false;

  return [
    /^(what|how)\s+about\s+(right\s+now|now|today|currently|the\s+latest)\??$/,
    /^and\s+(right\s+)?now\??$/,
    /^(now|right\s+now)\??$/,
  ].some((pattern) => pattern.test(normalized));
}

export function inferContextualFollowUpSearchQuery(
  promptText: string,
  messages: Array<Pick<Message, "role" | "text" | "status">>,
) {
  if (!isAmbiguousRealtimeFollowUp(promptText)) return null;

  const normalizedPrompt = normalizePromptText(promptText);
  const priorUsers = messages
    .filter((message) => message.role === "user")
    .filter((message) => message.status !== "failed" && message.status !== "cancelled")
    .map((message) => normalizePromptText(message.text ?? ""))
    .filter(Boolean);

  if (priorUsers.at(-1) === normalizedPrompt) priorUsers.pop();

  for (const priorPrompt of priorUsers.reverse()) {
    const query = inferForcedSearchQuery(priorPrompt);
    if (query) return query;
  }

  return null;
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
  const attemptedQueries = new Set<string>();
  const contextualFollowUpQuery = inferContextualFollowUpSearchQuery(
    input.promptText,
    input.messages,
  );

  for (let step = 1; step <= MAX_SEARCH_STEPS; step += 1) {
    await input.onProgress?.({
      label: searchRuns.length > 0 ? `Reviewing sources for step ${step}` : "Planning next step",
      state: "active",
      step,
    });
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

    const forcedDecision =
      searchRuns.length === 0
        ? contextualFollowUpQuery
          ? {
              action: "search" as const,
              summary: "Ambiguous follow-up resolved from prior realtime request",
              query: contextualFollowUpQuery,
              numResults: 5,
            }
          : forcedSearchDecision(input.promptText)
        : null;
    const shouldRewriteAmbiguousEcho =
      Boolean(contextualFollowUpQuery) &&
      decision.action === "search" &&
      stableQueryKey(decision.query) === stableQueryKey(input.promptText);
    if (forcedDecision && (decision.action !== "search" || shouldRewriteAmbiguousEcho)) {
      input.log?.("assistant_turn_search_forced", {
        assistantMessageId: input.assistantMessageId,
        step,
        originalAction: decision.action,
        originalQuery: decision.query,
        forcedQuery: forcedDecision.query,
        reason: contextualFollowUpQuery ? "contextual_follow_up" : "explicit_or_realtime",
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

    if (decision.action !== "search" || !decision.query.trim()) {
      await input.onProgress?.({
        label:
          searchRuns.length > 0
            ? "Search complete, drafting answer"
            : "Answering from current context",
        state: "completed",
        step,
        detail: decision.summary || undefined,
      });
      break;
    }

    const query = decision.query.trim();
    const queryKey = stableQueryKey(query);
    if (attemptedQueries.has(queryKey)) {
      input.log?.("assistant_turn_search_duplicate_query_skipped", {
        assistantMessageId: input.assistantMessageId,
        step,
        query,
      });
      await input.onProgress?.({
        label: `Skipping duplicate search for "${query}"`,
        state: "completed",
        step,
        query,
      });
      break;
    }
    attemptedQueries.add(queryKey);
    await input.onProgress?.({
      label: `Searching the web for "${query}"`,
      state: "active",
      step,
      query,
      detail: decision.summary || undefined,
    });

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
        await input.onProgress?.({
          label: `Found ${normalizedRows.length} result${normalizedRows.length === 1 ? "" : "s"} for "${query}"`,
          state: "completed",
          step,
          query,
          detail: run.previewText || undefined,
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
      await input.onProgress?.({
        label: `Search finished for "${query}"`,
        state: "completed",
        step,
        query,
        detail: run.previewText || undefined,
      });
    } catch (error) {
      input.log?.("assistant_turn_search_execution_error", {
        assistantMessageId: input.assistantMessageId,
        step,
        query,
        error: String(error),
      });
      const errorMessage = error instanceof Error ? error.message : String(error);
      searchRuns.push(
        createSearchRun({
          messageId: input.assistantMessageId,
          query,
          status: "failed",
          step,
          numResults: decision.numResults,
          errorMessage,
        }),
      );
      await input.onProgress?.({
        label: `Search failed for "${query}"`,
        state: "failed",
        step,
        query,
        detail: errorMessage,
      });
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
