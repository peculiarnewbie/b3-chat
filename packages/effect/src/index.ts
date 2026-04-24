import {
  createId,
  type TraceRun,
  type TraceSpan,
  type TraceSpanKind,
  type TraceStatus,
} from "@b3-chat/domain";
import { Cause, Context, Effect, Exit, Layer } from "effect";
import * as Schema from "effect/Schema";

export const AppEnvConfig = Schema.Struct({
  OPENCODE_GO_BASE_URL: Schema.String,
  OPENCODE_GO_API_KEY: Schema.String,
  OPENCODE_GO_MODEL_ALLOWLIST: Schema.optional(Schema.String),
  DEFAULT_MODEL_ID: Schema.String,
  APP_PUBLIC_URL: Schema.String,
  UPLOAD_TOKEN_SECRET: Schema.String,
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: Schema.String,
  CLOUDFLARE_ACCESS_AUD: Schema.String,
  DEV_AUTH_EMAIL: Schema.optional(Schema.String),
  EXA_API_KEY: Schema.optional(Schema.String),
  UPLOADS: Schema.Any,
  SYNC_ENGINE: Schema.Any,
  /** Cloudflare Browser Rendering binding. Present when `browser` is wired
   *  up in wrangler.jsonc; absent on local builds without the binding.
   *  The extract tool degrades gracefully when this is missing. */
  BROWSER: Schema.optional(Schema.Any),
});

export type AppEnv = Schema.Schema.Type<typeof AppEnvConfig>;

export type TraceContextValue = {
  traceRunId: string | null;
  traceId: string;
  parentSpanId: string | null;
  messageId: string | null;
  threadId: string | null;
  workspaceId: string | null;
  modelId: string | null;
  opId: string | null;
};

export type StructuredLogEntry = {
  scope: string;
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  details?: Record<string, unknown>;
};

export interface TraceRecorderService {
  readonly scope: string;
  startTraceRun(input: {
    traceRunId: string;
    traceId: string;
    rootSpanId: string;
    messageId: string | null;
    threadId: string | null;
    workspaceId: string | null;
    modelId: string | null;
    attrs?: Record<string, unknown>;
  }): Promise<void>;
  finishTraceRun(input: {
    traceRunId: string;
    status: TraceStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
    attrs?: Record<string, unknown>;
  }): Promise<void>;
  startSpan(input: {
    spanId: string;
    traceRunId: string | null;
    traceId: string;
    parentSpanId: string | null;
    messageId: string | null;
    name: string;
    kind: TraceSpanKind;
    attrs?: Record<string, unknown>;
  }): Promise<void>;
  finishSpan(input: {
    spanId: string;
    status: TraceStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
    attrs?: Record<string, unknown>;
    events?: Record<string, unknown>[];
  }): Promise<void>;
  log(entry: StructuredLogEntry): Promise<void>;
}

export const AppEnvTag = Context.Service<AppEnv>("@b3-chat/effect/AppEnv");
export const TraceRecorder = Context.Service<TraceRecorderService>("@b3-chat/effect/TraceRecorder");
export const TraceContext = Context.Service<TraceContextValue>("@b3-chat/effect/TraceContext");

type AppRuntimeInput = {
  env: AppEnv;
  traceRecorder: TraceRecorderService;
  traceContext: TraceContextValue;
};

export const AppRuntime = {
  layer(input: AppRuntimeInput) {
    return Layer.mergeAll(
      Layer.succeed(AppEnvTag, input.env),
      Layer.succeed(TraceRecorder, input.traceRecorder),
      Layer.succeed(TraceContext, input.traceContext),
    );
  },
};

export class CancelledError extends Error {
  readonly _tag = "CancelledError";

  constructor(message = "Cancelled") {
    super(message);
    this.name = this._tag;
  }
}

export class ProviderTimeoutError extends Error {
  readonly _tag = "ProviderTimeoutError";

  constructor(message: string) {
    super(message);
    this.name = this._tag;
  }
}

export class InvalidRequestError extends Error {
  readonly _tag = "InvalidRequestError";

  constructor(message: string) {
    super(message);
    this.name = this._tag;
  }
}

export class AuthError extends Error {
  readonly _tag = "AuthError";

  constructor(message: string) {
    super(message);
    this.name = this._tag;
  }
}

export class RateLimitError extends Error {
  readonly _tag = "RateLimitError";

  constructor(message: string) {
    super(message);
    this.name = this._tag;
  }
}

export class SearchFailureError extends Error {
  readonly _tag = "SearchFailureError";

  constructor(message: string) {
    super(message);
    this.name = this._tag;
  }
}

export class SyncFailureError extends Error {
  readonly _tag = "SyncFailureError";

  constructor(message: string) {
    super(message);
    this.name = this._tag;
  }
}

export class UnknownUpstreamError extends Error {
  readonly _tag = "UnknownUpstreamError";

  constructor(message: string) {
    super(message);
    this.name = this._tag;
  }
}

export type AppError =
  | CancelledError
  | ProviderTimeoutError
  | InvalidRequestError
  | AuthError
  | RateLimitError
  | SearchFailureError
  | SyncFailureError
  | UnknownUpstreamError;

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      errorCode: (error as { _tag?: string })._tag ?? error.name ?? "Error",
      errorMessage: error.message,
    };
  }
  return {
    errorCode: "UnknownUpstreamError",
    errorMessage: String(error),
  };
}

function statusFromExit(exit: Exit.Exit<unknown, unknown>): TraceStatus {
  if (Exit.isSuccess(exit)) return "completed";
  return Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : "failed";
}

function errorFromExit(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) {
    return {
      errorCode: null,
      errorMessage: null,
    };
  }
  const failure = exit.cause.reasons.find(Cause.isFailReason);
  if (failure) {
    return serializeError(failure.error);
  }
  const defect = exit.cause.reasons.find(Cause.isDieReason);
  if (defect) {
    return serializeError(defect.defect);
  }
  return serializeError(Cause.pretty(exit.cause));
}

export function decodeAppEnv(input: unknown) {
  return Schema.decodeUnknownSync(AppEnvConfig)(input);
}

export function createStructuredLogger(scope: string, defaults: Record<string, unknown> = {}) {
  return {
    scope,
    log(
      event: string,
      details?: Record<string, unknown>,
      level: StructuredLogEntry["level"] = "info",
    ) {
      const entry = {
        scope,
        event,
        level,
        ...defaults,
        ...details,
      };
      const message = JSON.stringify(entry);
      switch (level) {
        case "debug":
        case "info":
          console.log(message);
          break;
        case "warn":
          console.warn(message);
          break;
        case "error":
          console.error(message);
          break;
      }
    },
  };
}

export function makeTraceRecorder(input: {
  scope: string;
  logger?: ReturnType<typeof createStructuredLogger>;
  onTraceRunStart?: (
    row: Partial<TraceRun> &
      Pick<TraceRun, "id" | "traceId" | "rootSpanId" | "status" | "startedAt">,
  ) => Promise<void> | void;
  onTraceRunFinish?: (
    row: Partial<TraceRun> & Pick<TraceRun, "id" | "status" | "endedAt">,
  ) => Promise<void> | void;
  onSpanStart?: (
    row: Partial<TraceSpan> &
      Pick<TraceSpan, "id" | "traceId" | "name" | "kind" | "status" | "startedAt">,
  ) => Promise<void> | void;
  onSpanFinish?: (
    row: Partial<TraceSpan> & Pick<TraceSpan, "id" | "status" | "endedAt">,
  ) => Promise<void> | void;
}): TraceRecorderService {
  const logger = input.logger ?? createStructuredLogger(input.scope);
  const runs = new Map<string, { startedAt: number; attrs: Record<string, unknown> }>();
  const spans = new Map<string, { startedAt: number; attrs: Record<string, unknown> }>();

  return {
    scope: input.scope,
    async startTraceRun(traceRun) {
      runs.set(traceRun.traceRunId, {
        startedAt: Date.now(),
        attrs: traceRun.attrs ?? {},
      });
      const startedAt = new Date().toISOString();
      await input.onTraceRunStart?.({
        id: traceRun.traceRunId,
        messageId: traceRun.messageId,
        threadId: traceRun.threadId,
        workspaceId: traceRun.workspaceId,
        traceId: traceRun.traceId,
        rootSpanId: traceRun.rootSpanId,
        modelId: traceRun.modelId,
        status: "running",
        startedAt,
        endedAt: null,
        durationMs: null,
        errorCode: null,
        errorMessage: null,
        attrsJson: JSON.stringify(traceRun.attrs ?? {}),
      } as TraceRun);
      logger.log("trace_run_started", {
        traceRunId: traceRun.traceRunId,
        traceId: traceRun.traceId,
        rootSpanId: traceRun.rootSpanId,
        messageId: traceRun.messageId,
        threadId: traceRun.threadId,
        workspaceId: traceRun.workspaceId,
        modelId: traceRun.modelId,
        attrs: traceRun.attrs ?? {},
      });
    },
    async finishTraceRun(traceRun) {
      const existing = runs.get(traceRun.traceRunId);
      const endedAt = new Date().toISOString();
      const durationMs = existing ? Date.now() - existing.startedAt : null;
      await input.onTraceRunFinish?.({
        id: traceRun.traceRunId,
        status: traceRun.status,
        endedAt,
        durationMs,
        errorCode: traceRun.errorCode ?? null,
        errorMessage: traceRun.errorMessage ?? null,
        attrsJson: JSON.stringify({
          ...existing?.attrs,
          ...traceRun.attrs,
        }),
      } as TraceRun);
      logger.log(
        "trace_run_finished",
        {
          traceRunId: traceRun.traceRunId,
          status: traceRun.status,
          durationMs,
          errorCode: traceRun.errorCode ?? null,
          errorMessage: traceRun.errorMessage ?? null,
        },
        traceRun.status === "failed" ? "error" : traceRun.status === "cancelled" ? "warn" : "info",
      );
      runs.delete(traceRun.traceRunId);
    },
    async startSpan(span) {
      spans.set(span.spanId, {
        startedAt: Date.now(),
        attrs: span.attrs ?? {},
      });
      const startedAt = new Date().toISOString();
      await input.onSpanStart?.({
        id: span.spanId,
        traceRunId: span.traceRunId,
        traceId: span.traceId,
        parentSpanId: span.parentSpanId,
        messageId: span.messageId,
        name: span.name,
        kind: span.kind,
        status: "running",
        startedAt,
        endedAt: null,
        durationMs: null,
        errorCode: null,
        errorMessage: null,
        attrsJson: JSON.stringify(span.attrs ?? {}),
        eventsJson: JSON.stringify([]),
      } as TraceSpan);
      logger.log("trace_span_started", {
        traceRunId: span.traceRunId,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        messageId: span.messageId,
        spanName: span.name,
        kind: span.kind,
        attrs: span.attrs ?? {},
      });
    },
    async finishSpan(span) {
      const existing = spans.get(span.spanId);
      const endedAt = new Date().toISOString();
      const durationMs = existing ? Date.now() - existing.startedAt : null;
      await input.onSpanFinish?.({
        id: span.spanId,
        status: span.status,
        endedAt,
        durationMs,
        errorCode: span.errorCode ?? null,
        errorMessage: span.errorMessage ?? null,
        attrsJson: JSON.stringify({
          ...existing?.attrs,
          ...span.attrs,
        }),
        eventsJson: JSON.stringify(span.events ?? []),
      } as TraceSpan);
      logger.log(
        "trace_span_finished",
        {
          spanId: span.spanId,
          status: span.status,
          durationMs,
          errorCode: span.errorCode ?? null,
          errorMessage: span.errorMessage ?? null,
        },
        span.status === "failed" ? "error" : span.status === "cancelled" ? "warn" : "info",
      );
      spans.delete(span.spanId);
    },
    async log(entry) {
      logger.log(entry.event, entry.details, entry.level ?? "info");
    },
  };
}

export function makeRootTraceContext(input: {
  messageId?: string | null;
  threadId?: string | null;
  workspaceId?: string | null;
  modelId?: string | null;
  opId?: string | null;
}) {
  return {
    traceRunId: createId("trun"),
    traceId: createId("trace"),
    parentSpanId: null,
    messageId: input.messageId ?? null,
    threadId: input.threadId ?? null,
    workspaceId: input.workspaceId ?? null,
    modelId: input.modelId ?? null,
    opId: input.opId ?? null,
  } satisfies TraceContextValue;
}

export function runAppEffect<A, E, R>(effect: Effect.Effect<A, E, R>, input: AppRuntimeInput) {
  return Effect.runPromise(
    effect.pipe(Effect.provide(AppRuntime.layer(input))) as Effect.Effect<A, E, never>,
  );
}

export function traceEffect<A, E, R>(
  name: string,
  kind: TraceSpanKind,
  attrs: Record<string, unknown>,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const recorder = yield* TraceRecorder;
    const context = yield* TraceContext;
    const spanId = createId("span");
    yield* Effect.tryPromise(() =>
      recorder.startSpan({
        spanId,
        traceRunId: context.traceRunId,
        traceId: context.traceId,
        parentSpanId: context.parentSpanId,
        messageId: context.messageId,
        name,
        kind,
        attrs: {
          ...attrs,
          workspaceId: context.workspaceId,
          threadId: context.threadId,
          messageId: context.messageId,
          modelId: context.modelId,
          opId: context.opId,
        },
      }),
    );
    const childContext = {
      ...context,
      parentSpanId: spanId,
    } satisfies TraceContextValue;
    return yield* effect.pipe(
      Effect.provideService(TraceContext, childContext),
      Effect.onExit((exit) => {
        const status = statusFromExit(exit);
        const error = errorFromExit(exit);
        return Effect.tryPromise(() =>
          recorder.finishSpan({
            spanId,
            status,
            errorCode: error.errorCode,
            errorMessage: error.errorMessage,
          }),
        );
      }),
    );
  });
}
