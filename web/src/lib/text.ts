// Plain-text preview of a markdown comment for list rows. Strips the
// markup a reviewer or agent is likely to type so the excerpt reads as
// prose; it never renders, so it needs no sanitizing.
export function excerpt(markdown: string): string {
  // Code spans keep their text as typed, so `snake_case` or `a*b` in
  // one survives the emphasis stripping below.
  const code: string[] = [];
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, (_, c: string) => `\uE000${code.push(c) - 1}\uE000`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\*\*|[*~]/g, "")
    .replace(/(?<![\p{L}\p{N}])_{1,2}|_{1,2}(?![\p{L}\p{N}])/gu, "")
    .replace(/\uE000(\d+)\uE000/g, (_, i: string) => code[Number(i)])
    .replace(/\s+/g, " ")
    .trim();
}

// Byte counts the way GitHub prints file sizes: 1024-based, one decimal
// from a kilobyte up.
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
