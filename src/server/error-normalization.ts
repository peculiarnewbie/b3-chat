import { extractAssistantErrorFacts } from "../lib/assistant-errors";

export type NormalizedAssistantError = {
  errorCode: string;
  errorMessage: string;
  providerName: string | null;
  retryable: boolean;
};

function inferProviderName(modelId: string | null | undefined, errorMessage: string) {
  const providerPrefix = String(modelId ?? "")
    .split("/")[0]
    ?.trim();
  if (providerPrefix) return providerPrefix;

  const message = errorMessage.toLowerCase();
  if (message.includes("moonshot") || message.includes("kimi")) return "moonshot";
  if (message.includes("openai")) return "openai";
  if (message.includes("groq")) return "groq";
  if (message.includes("anthropic")) return "anthropic";
  return null;
}

export function normalizeAssistantError(input: {
  errorCode?: string | null;
  errorMessage?: string | null;
  modelId?: string | null;
}): NormalizedAssistantError {
  const facts = extractAssistantErrorFacts(input.errorCode, input.errorMessage);
  const providerName = inferProviderName(input.modelId, facts.rawMessage);

  if (facts.isCancelled) {
    return {
      errorCode: "cancelled",
      errorMessage: facts.rawMessage,
      providerName,
      retryable: true,
    };
  }

  if (facts.isReasoningIncompatible) {
    return {
      errorCode: "provider_reasoning_incompatible",
      errorMessage: facts.rawMessage,
      providerName,
      retryable: false,
    };
  }

  if (facts.isTimeout) {
    return {
      errorCode: "assistant_timeout",
      errorMessage: facts.rawMessage,
      providerName,
      retryable: true,
    };
  }

  if (facts.isInvalidRequest) {
    return {
      errorCode: "provider_invalid_request",
      errorMessage: facts.rawMessage,
      providerName,
      retryable: false,
    };
  }

  if (facts.isAuth) {
    return {
      errorCode: "provider_auth",
      errorMessage: facts.rawMessage,
      providerName,
      retryable: false,
    };
  }

  if (facts.isRateLimited) {
    return {
      errorCode: "provider_rate_limited",
      errorMessage: facts.rawMessage,
      providerName,
      retryable: true,
    };
  }

  if (facts.isSearchFailure) {
    return {
      errorCode: "search_failed",
      errorMessage: facts.rawMessage,
      providerName,
      retryable: true,
    };
  }

  return {
    errorCode: input.errorCode || "assistant_turn_error",
    errorMessage: facts.rawMessage,
    providerName,
    retryable: facts.isNetworkFailure || facts.statusCode == null,
  };
}
