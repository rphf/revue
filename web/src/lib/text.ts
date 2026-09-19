// Plain-text preview of a markdown comment for list rows. Strips the
// markup a reviewer or agent is likely to type so the excerpt reads as
// prose; it never renders, so it needs no sanitizing.
export function excerpt(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|[*_~])/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
