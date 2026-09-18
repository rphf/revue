import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

// Comment bodies come from reviewers AND agents — untrusted either
// way. Everything renders through markdown + DOMPurify; raw HTML never
// reaches the DOM (R4 hardening).
export default function Markdown({ source }: { source: string }) {
  const html = useMemo(() => {
    const rendered = marked.parse(source, { async: false }) as string;
    return DOMPurify.sanitize(rendered);
  }, [source]);
  return (
    <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
