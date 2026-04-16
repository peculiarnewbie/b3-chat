import { createId, type TraceSpanKind } from "@b3-chat/domain";
import {
  createStructuredLogger,
  makeRootTraceContext,
  makeTraceRecorder,
  runAppEffect,
  traceEffect,
  type AppEnv,
} from "@b3-chat/effect";
import { Effect } from "effect";

export async function runApiTrace<A>(input: {
  scope: string;
  name: string;
  kind: TraceSpanKind;
  env: AppEnv;
  attrs?: Record<string, unknown>;
  run: () => Promise<A>;
}) {
  const traceContext = makeRootTraceContext({});
  const rootSpanId = createId("span");
  const logger = createStructuredLogger(input.scope, {
    traceId: traceContext.traceId,
    traceRunId: traceContext.traceRunId,
    rootSpanId,
  });
  const recorder = makeTraceRecorder({
    scope: input.scope,
    logger,
  });

  await recorder.startTraceRun({
    traceRunId: traceContext.traceRunId,
    traceId: traceContext.traceId,
    rootSpanId,
    messageId: null,
    threadId: null,
    workspaceId: null,
    modelId: null,
    attrs: input.attrs ?? {},
  });
  await recorder.startSpan({
    spanId: rootSpanId,
    traceRunId: traceContext.traceRunId,
    traceId: traceContext.traceId,
    parentSpanId: null,
    messageId: null,
    name: `${input.scope}.request`,
    kind: "root",
    attrs: input.attrs ?? {},
  });

  try {
    const result = await runAppEffect(
      traceEffect(input.name, input.kind, input.attrs ?? {}, Effect.tryPromise(input.run)),
      {
        env: input.env,
        traceRecorder: recorder,
        traceContext: {
          ...traceContext,
          parentSpanId: rootSpanId,
        },
      },
    );
    await recorder.finishSpan({
      spanId: rootSpanId,
      status: "completed",
    });
    await recorder.finishTraceRun({
      traceRunId: traceContext.traceRunId,
      status: "completed",
    });
    return result;
  } catch (error) {
    const errorCode = error instanceof Error ? error.name : "Error";
    const errorMessage = error instanceof Error ? error.message : String(error);
    await recorder.finishSpan({
      spanId: rootSpanId,
      status: "failed",
      errorCode,
      errorMessage,
    });
    await recorder.finishTraceRun({
      traceRunId: traceContext.traceRunId,
      status: "failed",
      errorCode,
      errorMessage,
    });
    throw error;
  }
}
