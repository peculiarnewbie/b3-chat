import { createMemo, type Component } from "solid-js";
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

const Markdown: Component<{ text: string }> = (props) => {
  const html = createMemo(() => {
    const raw = props.text || "";
    const rendered = marked.parse(raw, { async: false }) as string;
    return DOMPurify.sanitize(rendered, { ADD_ATTR: ["data-code"] });
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

  return <div class="md-content" innerHTML={html()} onClick={handleClick} />;
};

export default Markdown;
