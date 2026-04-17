type ClientLogLevel = "info" | "warn" | "error";

const pageSessionId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function emit(
  level: ClientLogLevel,
  scope: string,
  event: string,
  defaults: Record<string, unknown>,
  details?: Record<string, unknown>,
) {
  const entry = {
    ts: new Date().toISOString(),
    side: "client",
    pageSessionId,
    scope,
    event,
    ...defaults,
    ...details,
  };
  const line = JSON.stringify(entry);
  switch (level) {
    case "info":
      console.log(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }
}

export function createClientLogger(scope: string, defaults: Record<string, unknown> = {}) {
  return {
    log(event: string, details?: Record<string, unknown>) {
      emit("info", scope, event, defaults, details);
    },
    warn(event: string, details?: Record<string, unknown>) {
      emit("warn", scope, event, defaults, details);
    },
    error(event: string, details?: Record<string, unknown>) {
      emit("error", scope, event, defaults, details);
    },
  };
}

export function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: String(error),
  };
}

export function previewText(value: string | null | undefined, limit = 120) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}
