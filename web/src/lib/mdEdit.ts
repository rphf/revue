// Markdown editing on a textarea's text, as GitHub's comment box does
// it. Each operation takes the text and the selection and returns one
// replacement, so the caller can apply it as a single undoable edit.

export interface Edit {
  // The range of the old text to replace, and what replaces it.
  from: number;
  to: number;
  text: string;
  // The selection to leave, in the new text.
  selStart: number;
  selEnd: number;
}

// wrap puts before and after around the selection, or takes them off
// when they are already there.
export function wrap(
  value: string,
  start: number,
  end: number,
  before: string,
  after = before,
): Edit {
  if (
    value.slice(start - before.length, start) === before &&
    value.slice(end, end + after.length) === after
  ) {
    const from = start - before.length;
    return {
      from,
      to: end + after.length,
      text: value.slice(start, end),
      selStart: from,
      selEnd: from + (end - start),
    };
  }
  const selected = value.slice(start, end);
  return {
    from: start,
    to: end,
    text: before + selected + after,
    selStart: start + before.length,
    selEnd: start + before.length + selected.length,
  };
}

// code marks the selection as code: inline within a line, a fenced
// block across lines.
export function code(value: string, start: number, end: number): Edit {
  const selected = value.slice(start, end);
  if (!selected.includes("\n")) return wrap(value, start, end, "`");
  const text = "```\n" + selected + "\n```";
  return {
    from: start,
    to: end,
    text,
    selStart: start + 4,
    selEnd: start + 4 + selected.length,
  };
}

// link makes the selection a link's text and selects the URL to type.
// With nothing selected the caret goes where the text goes.
export function link(value: string, start: number, end: number): Edit {
  const selected = value.slice(start, end);
  const text = `[${selected}](url)`;
  if (selected === "") {
    return {
      from: start,
      to: end,
      text,
      selStart: start + 1,
      selEnd: start + 1,
    };
  }
  const url = start + selected.length + 3;
  return { from: start, to: end, text, selStart: url, selEnd: url + 3 };
}

export type LinePrefix = "quote" | "bullet" | "number" | "task";

const PREFIX: Record<LinePrefix, RegExp> = {
  quote: /^> ?/,
  bullet: /^[-*+] (?!\[[ xX]\] )/,
  number: /^\d+[.)] /,
  task: /^[-*+] \[[ xX]\] /,
};

function marker(kind: LinePrefix, i: number): string {
  switch (kind) {
    case "quote":
      return "> ";
    case "bullet":
      return "- ";
    case "number":
      return `${i + 1}. `;
    case "task":
      return "- [ ] ";
  }
}

// prefixLines starts every selected line with a quote or list marker,
// or takes the markers off when every line already has them.
export function prefixLines(
  value: string,
  start: number,
  end: number,
  kind: LinePrefix,
): Edit {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", end);
  const to = lineEnd === -1 ? value.length : lineEnd;
  const lines = value.slice(from, to).split("\n");
  const all = lines.every((l) => PREFIX[kind].test(l));
  const text = lines
    .map((l, i) => (all ? l.replace(PREFIX[kind], "") : marker(kind, i) + l))
    .join("\n");
  if (start === end && !all) {
    const caret = start + marker(kind, 0).length;
    return { from, to, text, selStart: caret, selEnd: caret };
  }
  return { from, to, text, selStart: from, selEnd: from + text.length };
}

const LIST_ITEM = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) )(.*)$/;

// continueList answers Enter at the end of a list item: the next line
// starts the next item. Enter on an empty item ends the list instead.
// null leaves Enter to the textarea.
export function continueList(
  value: string,
  start: number,
  end: number,
): Edit | null {
  if (start !== end) return null;
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", start);
  const line = value.slice(from, lineEnd === -1 ? value.length : lineEnd);
  const m = LIST_ITEM.exec(line);
  if (!m || start < from + m[1].length + m[2].length) return null;
  const [, indent, mark, num, delim, rest] = m;
  if (rest.trim() === "") {
    return {
      from,
      to: from + line.length,
      text: "",
      selStart: from,
      selEnd: from,
    };
  }
  const next =
    num !== undefined
      ? `${Number(num) + 1}${delim} `
      : mark.includes("[")
        ? mark.slice(0, 2) + "[ ] "
        : mark;
  const text = "\n" + indent + next;
  return {
    from: start,
    to: start,
    text,
    selStart: start + text.length,
    selEnd: start + text.length,
  };
}

// indentList moves the selected list items in or out by one level with
// Tab and Shift-Tab. null when a selected line is not a list item, so
// Tab keeps moving focus as usual.
export function indentList(
  value: string,
  start: number,
  end: number,
  outdent: boolean,
): Edit | null {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", end);
  const to = lineEnd === -1 ? value.length : lineEnd;
  const lines = value.slice(from, to).split("\n");
  if (!lines.every((l) => LIST_ITEM.test(l))) return null;
  if (outdent && !lines.some((l) => l.startsWith(" "))) return null;
  const moved = lines.map((l) =>
    outdent ? l.replace(/^ {1,2}/, "") : "  " + l,
  );
  const text = moved.join("\n");
  const shift = moved[0].length - lines[0].length;
  return {
    from,
    to,
    text,
    selStart: Math.max(from, start + shift),
    selEnd: end + (text.length - (to - from)),
  };
}

const URL_ONLY = /^https?:\/\/\S+$/;

// pasteLink turns a URL pasted over selected text into a link to it.
// null leaves the paste alone.
export function pasteLink(
  value: string,
  start: number,
  end: number,
  pasted: string,
): Edit | null {
  const url = pasted.trim();
  const selected = value.slice(start, end);
  if (start === end || !URL_ONLY.test(url) || URL_ONLY.test(selected.trim()))
    return null;
  const text = `[${selected}](${url})`;
  return {
    from: start,
    to: end,
    text,
    selStart: start + text.length,
    selEnd: start + text.length,
  };
}
