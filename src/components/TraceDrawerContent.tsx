import { For, Show, createSignal } from "solid-js";

export type TraceDrawerSpan = {
  id: string;
  name: string;
  status: string;
  durationMs: number | null;
  errorMessage?: string | null;
  attrs: Record<string, unknown>;
  events: Record<string, unknown>[];
  children: TraceDrawerSpan[];
};

export type TraceDrawerTrace = {
  traceId: string;
  status: string;
  modelId: string | null | undefined;
  durationMs: number | null;
  errorMessage: string | null | undefined;
  attrs: Record<string, unknown>;
  spans: TraceDrawerSpan[];
  copyText: string;
};

type TraceDrawerContentProps = {
  traces: TraceDrawerTrace[];
  formatDuration: (ms: number) => string;
  formatTraceStatus: (status: string) => string;
  shortTraceId: (traceId: string) => string;
};

function TraceSpanTree(props: {
  span: TraceDrawerSpan;
  formatDuration: (ms: number) => string;
  formatTraceStatus: (status: string) => string;
}) {
  return (
    <div class="trace-span-node">
      <div
        classList={{
          "trace-span-header": true,
          "is-failed": props.span.status === "failed",
          "is-cancelled": props.span.status === "cancelled",
        }}
      >
        <span class="trace-span-name">{props.span.name}</span>
        <span class="trace-span-meta">
          <span>{props.formatTraceStatus(props.span.status)}</span>
          <Show when={props.span.durationMs != null}>
            <span>{props.formatDuration(props.span.durationMs!)}</span>
          </Show>
        </span>
      </div>
      <Show
        when={
          Object.keys(props.span.attrs).length > 0 ||
          props.span.errorMessage ||
          props.span.events.length > 0
        }
      >
        <details class="trace-span-details">
          <summary>Details</summary>
          <Show when={Object.keys(props.span.attrs).length > 0}>
            <pre>{JSON.stringify(props.span.attrs, null, 2)}</pre>
          </Show>
          <Show when={props.span.errorMessage}>
            <pre>{props.span.errorMessage}</pre>
          </Show>
          <Show when={props.span.events.length > 0}>
            <pre>{JSON.stringify(props.span.events, null, 2)}</pre>
          </Show>
        </details>
      </Show>
      <Show when={props.span.children.length > 0}>
        <div class="trace-span-children">
          <For each={props.span.children}>
            {(child) => (
              <TraceSpanTree
                span={child}
                formatDuration={props.formatDuration}
                formatTraceStatus={props.formatTraceStatus}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function TraceCopyButton(props: { text: string }) {
  const [copied, setCopied] = createSignal(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      class="trace-copy-btn"
      aria-label="Copy trace JSON"
      title="Copy trace JSON"
      onClick={() => void handleCopy()}
    >
      {copied() ? "Copied" : "Copy"}
    </button>
  );
}

export default function TraceDrawerContent(props: TraceDrawerContentProps) {
  return (
    <>
      <For each={props.traces}>
        {(trace) => (
          <div class="trace-run-card">
            <div class="trace-run-header">
              <span class="trace-run-id">trace {props.shortTraceId(trace.traceId)}</span>
              <div class="trace-run-actions">
                <span class="trace-run-badges">
                  <span>{props.formatTraceStatus(trace.status)}</span>
                  <Show when={trace.modelId}>
                    <span>{trace.modelId}</span>
                  </Show>
                  <Show when={trace.attrs.searchEnabled === true}>
                    <span>search</span>
                  </Show>
                  <Show when={trace.durationMs != null}>
                    <span>{props.formatDuration(trace.durationMs!)}</span>
                  </Show>
                </span>
                <TraceCopyButton text={trace.copyText} />
              </div>
            </div>
            <Show when={trace.errorMessage}>
              <div class="trace-run-error">{trace.errorMessage}</div>
            </Show>
            <Show when={trace.spans.length > 0}>
              <div class="trace-tree">
                <For each={trace.spans}>
                  {(span) => (
                    <TraceSpanTree
                      span={span}
                      formatDuration={props.formatDuration}
                      formatTraceStatus={props.formatTraceStatus}
                    />
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
    </>
  );
}
