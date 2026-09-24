import { marked } from "marked";
import DOMPurify from "dompurify";

const ALERTS = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
} as const;

const ALERT_TAG = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][^\S\n]*\n?/;

// renderMarkdown turns a comment body into safe HTML. Bodies come from
// reviewers and agents, untrusted either way: everything goes through
// markdown and DOMPurify, and raw HTML never reaches the DOM. A newline
// is a line break, as in a GitHub comment, so text reads as typed. A
// quote that opens with [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or
// [!CAUTION] becomes a GitHub alert; that rewrite works on the
// sanitized tree, so it adds no markup DOMPurify has not seen.
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false, breaks: true }) as string;
  const doc = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
  for (const quote of doc.querySelectorAll("blockquote")) alert(quote);
  const out = document.createElement("div");
  out.append(doc);
  return out.innerHTML;
}

function alert(quote: HTMLQuoteElement) {
  const first = quote.firstElementChild;
  if (first?.tagName !== "P") return;
  const lead = first.firstChild;
  if (lead?.nodeType !== Node.TEXT_NODE) return;
  const m = ALERT_TAG.exec(lead.textContent ?? "");
  if (!m) return;
  const kind = m[1] as keyof typeof ALERTS;
  lead.textContent = (lead.textContent ?? "").slice(m[0].length);
  // A line break after the tag, from breaks: true, is not content.
  if (
    first.firstChild?.textContent === "" &&
    first.firstChild.nextSibling?.nodeName === "BR"
  )
    first.firstChild.nextSibling.remove();
  if (first.textContent?.trim() === "" && first.children.length === 0)
    first.remove();

  const box = document.createElement("div");
  box.className = `markdown-alert markdown-alert-${kind.toLowerCase()}`;
  const title = document.createElement("p");
  title.className = "markdown-alert-title";
  title.textContent = ALERTS[kind];
  box.append(title, ...quote.childNodes);
  quote.replaceWith(box);
}
