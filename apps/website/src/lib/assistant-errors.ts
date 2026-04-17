export type AssistantErrorCategory =
  | "cancelled"
  | "timeout"
  | "invalid_request"
  | "auth"
  | "rate_limited"
  | "search"
  | "network"
  | "unknown";

export type AssistantErrorExplanation = {
  title: string;
  summary: string;
  explanation: string;
  details: string;
  retryable: boolean;
  category: AssistantErrorCategory;
  providerMessage: string;
};

type AssistantErrorFacts = {
  rawMessage: string;
  providerMessage: string;
  statusCode: number | null;
  isCancelled: boolean;
  isTimeout: boolean;
  isReasoningIncompatible: boolean;
  isInvalidRequest: boolean;
  isAuth: boolean;
  isRateLimited: boolean;
  isSearchFailure: boolean;
  isNetworkFailure: boolean;
};

function cleanText(value: string | null | undefined) {
  return String(value ?? "")
    .split("\u0000")
    .join("")
    .trim();
}

function stripCommonWrappers(value: string) {
  return value
    .replace(/^provider returned error:\s*/i, "")
    .replace(/^error:\s*/i, "")
    .trim();
}

function tryParseJsonCandidate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  const objectStart = trimmed.indexOf("{");
  if (objectStart > 0) candidates.push(trimmed.slice(objectStart));
  const arrayStart = trimmed.indexOf("[");
  if (arrayStart > 0) candidates.push(trimmed.slice(arrayStart));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function extractDeepMessage(value: unknown, seen = new Set<object>()): string | null {
  if (typeof value === "string") {
    const trimmed = stripCommonWrappers(cleanText(value));
    if (!trimmed) return null;
    const parsed = tryParseJsonCandidate(trimmed);
    if (parsed && typeof parsed === "object") {
      const nested = extractDeepMessage(parsed, seen);
      if (nested) return nested;
    }
    return trimmed;
  }

  if (!value || typeof value !== "object") return null;
  if (seen.has(value as object)) return null;
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractDeepMessage(item, seen);
      if (nested) return nested;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = [
    "error",
    "message",
    "detail",
    "details",
    "metadata",
    "raw",
    "body",
    "response",
  ];

  for (const key of preferredKeys) {
    if (!(key in record)) continue;
    const nested = extractDeepMessage(record[key], seen);
    if (nested) return nested;
  }

  for (const nestedValue of Object.values(record)) {
    const nested = extractDeepMessage(nestedValue, seen);
    if (nested) return nested;
  }

  return null;
}

function detectStatusCode(rawMessage: string, providerMessage: string) {
  const match = `${rawMessage}\n${providerMessage}`.match(/\bHTTP\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

export function extractAssistantErrorFacts(
  errorCode: string | null | undefined,
  errorMessage: string | null | undefined,
): AssistantErrorFacts {
  const rawMessage = cleanText(errorMessage) || "Unknown error";
  const providerMessage = extractDeepMessage(rawMessage) ?? rawMessage;
  const statusCode = detectStatusCode(rawMessage, providerMessage);
  const haystack = `${errorCode ?? ""}\n${rawMessage}\n${providerMessage}`.toLowerCase();

  return {
    rawMessage,
    providerMessage,
    statusCode,
    isCancelled: errorCode === "cancelled",
    isTimeout: /timed out|timeout|deadline exceeded|request timeout|stream timeout|etimedout/.test(
      haystack,
    ),
    isReasoningIncompatible:
      /reasoning_content is missing|thinking is enabled but reasoning_content is missing/.test(
        haystack,
      ),
    isInvalidRequest:
      statusCode === 400 ||
      /invalid request|unsupported field|unsupported parameter|unsupported option|missing required|bad request|invalid value|invalid parameter/.test(
        haystack,
      ),
    isAuth:
      statusCode === 401 ||
      statusCode === 403 ||
      /unauthorized|forbidden|invalid api key|api key|permission denied|quota|billing|insufficient_quota|account restricted|account suspended/.test(
        haystack,
      ),
    isRateLimited:
      statusCode === 429 ||
      statusCode === 503 ||
      /rate limit|too many requests|overloaded|overload|server busy|temporarily unavailable|service unavailable/.test(
        haystack,
      ),
    isSearchFailure:
      errorCode === "search_failed" ||
      /search failed|exa_web_search|tool execution|tool call|tool use|tool flow/.test(haystack),
    isNetworkFailure:
      /failed to fetch|fetch failed|network|connection reset|connection error|socket hang up|econnreset|enotfound|eai_again|tls|upstream connect|could not connect/.test(
        haystack,
      ),
  };
}

export function explainAssistantError(input: {
  errorCode: string | null | undefined;
  errorMessage: string | null | undefined;
}): AssistantErrorExplanation {
  const facts = extractAssistantErrorFacts(input.errorCode, input.errorMessage);

  if (facts.isCancelled) {
    return {
      title: "Response failed",
      summary: "The request was cancelled.",
      explanation: "The response stopped before the assistant finished generating an answer.",
      details: facts.rawMessage,
      retryable: true,
      category: "cancelled",
      providerMessage: facts.providerMessage,
    };
  }

  if (facts.isReasoningIncompatible) {
    return {
      title: "Response failed",
      summary: "This model's thinking mode is incompatible with tool use in this flow.",
      explanation:
        "The provider rejected the tool continuation because it said the required hidden reasoning replay field was missing. This app does attempt to preserve that field now, so this usually points to a provider incompatibility or an unsupported response shape.",
      details: facts.rawMessage,
      retryable: false,
      category: "invalid_request",
      providerMessage: facts.providerMessage,
    };
  }

  if (facts.isTimeout) {
    return {
      title: "Response failed",
      summary: "The model backend took too long to respond.",
      explanation:
        "The upstream model service did not finish the request within the timeout window. Retrying usually works if the provider is healthy.",
      details: facts.rawMessage,
      retryable: true,
      category: "timeout",
      providerMessage: facts.providerMessage,
    };
  }

  if (facts.isInvalidRequest) {
    return {
      title: "Response failed",
      summary: "The model provider rejected this request.",
      explanation:
        "The provider reported that this request shape or option combination was invalid, unsupported, or incomplete.",
      details: facts.rawMessage,
      retryable: false,
      category: "invalid_request",
      providerMessage: facts.providerMessage,
    };
  }

  if (facts.isAuth) {
    return {
      title: "Response failed",
      summary: "The provider account could not complete this request.",
      explanation:
        "The configured provider credentials, billing state, or account permissions blocked the request.",
      details: facts.rawMessage,
      retryable: false,
      category: "auth",
      providerMessage: facts.providerMessage,
    };
  }

  if (facts.isRateLimited) {
    return {
      title: "Response failed",
      summary: "The provider is rate limited or temporarily overloaded.",
      explanation:
        "The upstream model service could not accept this request right now. Waiting and retrying usually resolves it.",
      details: facts.rawMessage,
      retryable: true,
      category: "rate_limited",
      providerMessage: facts.providerMessage,
    };
  }

  if (facts.isSearchFailure) {
    return {
      title: "Response failed",
      summary: "A tool or search step failed before the response could complete.",
      explanation:
        "The assistant started a tool-enabled turn, but one of the external steps failed and the response could not finish cleanly.",
      details: facts.rawMessage,
      retryable: true,
      category: "search",
      providerMessage: facts.providerMessage,
    };
  }

  if (facts.isNetworkFailure) {
    return {
      title: "Response failed",
      summary: "The app could not reach the model provider.",
      explanation:
        "The request appears to have failed in transit or during upstream connectivity, before the provider returned a normal response.",
      details: facts.rawMessage,
      retryable: true,
      category: "network",
      providerMessage: facts.providerMessage,
    };
  }

  return {
    title: "Response failed",
    summary: "The assistant ran into an unexpected error.",
    explanation:
      "The request failed for a reason the app could not classify more specifically. The technical details below preserve the provider response for debugging.",
    details: facts.rawMessage,
    retryable: true,
    category: "unknown",
    providerMessage: facts.providerMessage,
  };
}
