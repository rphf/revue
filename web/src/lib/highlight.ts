import { codeToHtml } from "@pierre/diffs";
import DOMPurify from "dompurify";
import { THEMES } from "../components/codeViewStyle";

// highlightCode colors the fenced code blocks under root that name a
// language, with the diff's own GitHub themes: each token carries both
// colors and the page's theme picks one. A block in a language Shiki
// does not know stays plain. alive reports whether root still shows
// the same text, since a grammar can take a moment to load.
export async function highlightCode(
  root: HTMLElement,
  alive: () => boolean,
): Promise<void> {
  const blocks = root.querySelectorAll<HTMLElement>(
    "pre > code[class*='language-']",
  );
  for (const block of blocks) {
    const lang = /language-(\S+)/.exec(block.className)?.[1];
    if (!lang) continue;
    let html: string;
    try {
      html = await codeToHtml((block.textContent ?? "").replace(/\n$/, ""), {
        lang,
        themes: THEMES,
        defaultColor: false,
      });
    } catch {
      continue;
    }
    if (!alive() || !block.isConnected) return;
    const tpl = document.createElement("template");
    tpl.innerHTML = DOMPurify.sanitize(html);
    const pre = tpl.content.firstElementChild;
    if (pre) block.parentElement?.replaceWith(pre);
  }
}
