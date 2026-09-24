import { useEffect, useMemo, useRef } from "react";
import { highlightCode } from "@/lib/highlight";
import { renderMarkdown } from "@/lib/markdown";

// A comment body, rendered: see renderMarkdown for what is allowed.
// Code blocks are colored after the first paint, once their grammar
// has loaded.
export default function Markdown({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(source), [source]);
  useEffect(() => {
    const root = ref.current;
    if (!root || !root.querySelector("pre > code[class*='language-']")) return;
    let alive = true;
    void highlightCode(root, () => alive);
    return () => {
      alive = false;
    };
  }, [html]);
  return (
    <div
      ref={ref}
      className="markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
