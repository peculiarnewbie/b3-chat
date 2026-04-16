import { createMemo, Show, type Component } from "solid-js";
import { Marked, Renderer } from "marked";
import { markedHighlight } from "marked-highlight";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);

const renderer = new Renderer();
renderer.code = ({ text, lang }) => {
  const langLabel = lang ? `<span class="code-lang">${lang}</span>` : "";
  return `<div class="code-block"><div class="code-header">${langLabel}<button class="copy-btn" data-code="${encodeURIComponent(text)}">Copy</button></div><pre><code>${text}</code></pre></div>`;
};

const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
  {
    gfm: true,
    breaks: true,
  },
);
marked.use({ renderer });

/* ── Inline citation injection ────────────────────── */

export interface Citation {
  url: string;
  title: string;
  domain: string;
  snippet: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Replace `[N]` markers in rendered HTML with interactive citation badges.
 * Skips replacements inside <code>, <pre>, and <a> elements.
 */
function injectCitations(html: string, citations: Citation[]): string {
  if (!citations.length) return html;

  let codeDepth = 0;
  let linkDepth = 0;

  return html.replace(
    /(<\/?(?:code|pre|a)(?:\s[^>]*)?>)|(\[(\d+)\])/gi,
    (match, tag, _cite, numStr) => {
      if (tag) {
        if (/^<(?:code|pre)[\s>]/i.test(tag)) codeDepth++;
        if (/^<\/(?:code|pre)>/i.test(tag)) codeDepth = Math.max(0, codeDepth - 1);
        if (/^<a[\s>]/i.test(tag)) linkDepth++;
        if (/^<\/a>/i.test(tag)) linkDepth = Math.max(0, linkDepth - 1);
        return tag;
      }
      if (codeDepth > 0 || linkDepth > 0) return match;

      const idx = parseInt(numStr, 10) - 1;
      if (idx < 0 || idx >= citations.length) return match;

      const cite = citations[idx];
      const t = escapeHtml(cite.title);
      const d = escapeHtml(cite.domain);
      const u = escapeHtml(cite.url);

      return (
        `<a class="cite-ref" href="${u}" target="_blank" rel="noreferrer">` +
        `<sup>${numStr}</sup>` +
        `<span class="cite-tip">` +
        `<span class="cite-tip-title">${t}</span>` +
        `<span class="cite-tip-domain">${d}</span>` +
        `</span></a>`
      );
    },
  );
}

const Markdown: Component<{
  text: string;
  streaming?: boolean;
  citations?: Citation[];
}> = (props) => {
  const html = createMemo(() => {
    const raw = props.text || "";
    const rendered = marked.parse(raw, { async: false }) as string;
    const sanitized = DOMPurify.sanitize(rendered, { ADD_ATTR: ["data-code"] });
    let result = sanitized
      .replace(/<table>/g, '<div class="table-wrap"><table>')
      .replace(/<\/table>/g, "</table></div>");

    if (props.citations?.length) {
      result = injectCitations(result, props.citations);
    }

    return result;
  });

  const handleClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("copy-btn")) return;
    const code = decodeURIComponent(target.getAttribute("data-code") || "");
    void navigator.clipboard.writeText(code);
    target.textContent = "Copied!";
    setTimeout(() => {
      target.textContent = "Copy";
    }, 1500);
  };

  return (
    <div classList={{ "assistant-streaming-text": !!props.streaming }}>
      <div class="md-content" innerHTML={html()} onClick={handleClick} />
      <Show when={props.streaming}>
        <span class="streaming-cursor" aria-hidden="true" />
      </Show>
    </div>
  );
};

export default Markdown;
