import {
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  BoldIcon,
  CodeIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  TextQuoteIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  code,
  continueList,
  type Edit,
  indentList,
  link,
  pasteLink,
  prefixLines,
  wrap,
} from "@/lib/mdEdit";
import { IS_MAC } from "@/lib/platform";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import Markdown from "./Markdown";

const MOD = IS_MAC ? "⌘" : "Ctrl";
const SHIFT = IS_MAC ? "⇧" : "Shift";

type Op = (value: string, start: number, end: number) => Edit;

interface Tool {
  label: string;
  icon: ReactNode;
  op: Op;
  keys?: string[];
}

// GitHub's comment toolbar and, where they do not clash with the
// page's own, its keys. ⌘B and ⌘I stay the page's: they show and hide
// the files and the threads.
const TOOLS: Tool[] = [
  { label: "Bold", icon: <BoldIcon />, op: (v, s, e) => wrap(v, s, e, "**") },
  {
    label: "Italic",
    icon: <ItalicIcon />,
    op: (v, s, e) => wrap(v, s, e, "_"),
  },
  { label: "Code", icon: <CodeIcon />, op: code, keys: [MOD, "E"] },
  { label: "Link", icon: <LinkIcon />, op: link, keys: [MOD, "K"] },
  {
    label: "Quote",
    icon: <TextQuoteIcon />,
    op: (v, s, e) => prefixLines(v, s, e, "quote"),
    keys: [MOD, SHIFT, "."],
  },
  {
    label: "Bulleted list",
    icon: <ListIcon />,
    op: (v, s, e) => prefixLines(v, s, e, "bullet"),
    keys: [MOD, SHIFT, "8"],
  },
  {
    label: "Numbered list",
    icon: <ListOrderedIcon />,
    op: (v, s, e) => prefixLines(v, s, e, "number"),
    keys: [MOD, SHIFT, "7"],
  },
  {
    label: "Task list",
    icon: <ListTodoIcon />,
    op: (v, s, e) => prefixLines(v, s, e, "task"),
  },
];

// The tool a key combination inside the box stands for. Shifted digits
// and the period are read by their key, not the character a layout
// gives them.
function toolFor(e: KeyboardEvent): Tool | undefined {
  if (!(IS_MAC ? e.metaKey : e.ctrlKey) || e.altKey) return undefined;
  const name = e.shiftKey
    ? { Period: "Quote", Digit8: "Bulleted list", Digit7: "Numbered list" }[
        e.code
      ]
    : { e: "Code", k: "Link" }[e.key.toLowerCase()];
  return TOOLS.find((t) => t.label === name);
}

// apply makes one edit the textarea's own, so ⌘Z undoes it: the
// browser's insertText where it has it, a plain replace otherwise.
function nativeEdit(text: string): boolean {
  try {
    return text === ""
      ? document.execCommand("delete")
      : document.execCommand("insertText", false, text);
  } catch {
    return false;
  }
}

function apply(ta: HTMLTextAreaElement, edit: Edit) {
  ta.focus();
  ta.setSelectionRange(edit.from, edit.to);
  // Deleting an empty range would take a character with it.
  const empty = edit.from === edit.to && edit.text === "";
  if (!empty && !nativeEdit(edit.text)) {
    ta.setRangeText(edit.text, edit.from, edit.to, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  ta.setSelectionRange(edit.selStart, edit.selEnd);
}

export interface MarkdownEditorProps extends Omit<
  ComponentProps<"textarea">,
  "value" | "onChange" | "ref"
> {
  value: string;
  onValueChange: (value: string) => void;
  ref?: Ref<HTMLTextAreaElement>;
}

// A comment box that writes markdown the way GitHub's does: Write and
// Preview tabs, a formatting toolbar, lists that continue on Enter and
// indent on Tab, and a URL pasted over text that becomes a link. The
// textarea stays mounted under Preview, so its text, undo history and
// focus target survive the switch.
export default function MarkdownEditor({
  value,
  onValueChange,
  ref,
  className,
  onKeyDown,
  ...props
}: MarkdownEditorProps) {
  const own = useRef<HTMLTextAreaElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const [previewing, setPreviewing] = useState(false);
  const setRefs = (el: HTMLTextAreaElement | null) => {
    own.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };

  const run = (op: Op) => {
    const ta = own.current;
    if (!ta) return;
    apply(ta, op(ta.value, ta.selectionStart, ta.selectionEnd));
  };

  const switchTo = (next: boolean) => {
    setPreviewing(next);
    requestAnimationFrame(() =>
      next ? preview.current?.focus() : own.current?.focus(),
    );
  };

  // ⌘⇧P switches tabs from either one; the caller's keys (submit,
  // cancel) work from both.
  const onBoxKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((IS_MAC ? e.metaKey : e.ctrlKey) && e.shiftKey && e.code === "KeyP") {
      e.preventDefault();
      switchTo(!previewing);
      return;
    }
    onKeyDown?.(e as KeyboardEvent<HTMLTextAreaElement>);
  };

  const onTextKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const tool = toolFor(e);
    let edit: Edit | null = null;
    if (tool) edit = tool.op(ta.value, ta.selectionStart, ta.selectionEnd);
    else if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.nativeEvent.isComposing
    )
      edit = continueList(ta.value, ta.selectionStart, ta.selectionEnd);
    else if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey)
      edit = indentList(
        ta.value,
        ta.selectionStart,
        ta.selectionEnd,
        e.shiftKey,
      );
    if (edit) {
      e.preventDefault();
      apply(ta, edit);
      return;
    }
    onBoxKeyDown(e);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const edit = pasteLink(
      ta.value,
      ta.selectionStart,
      ta.selectionEnd,
      e.clipboardData.getData("text/plain"),
    );
    if (!edit) return;
    e.preventDefault();
    apply(ta, edit);
  };

  const tab = (label: string, on: boolean, next: boolean) => (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={() => switchTo(next)}
      className={cn(
        "shrink-0 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors",
        on
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="rounded-lg border border-input bg-background focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
      {/* In a narrow column the toolbar drops under the tabs. */}
      <div className="flex flex-wrap items-center gap-1 border-b px-1.5 py-1">
        <div
          role="tablist"
          aria-label="Comment mode"
          className="flex shrink-0 gap-0.5"
        >
          {tab("Write", !previewing, false)}
          {tab("Preview", previewing, true)}
        </div>
        {!previewing && (
          <TooltipProvider>
            <div
              role="toolbar"
              aria-label="Formatting"
              className="ml-auto flex flex-wrap items-center"
            >
              {TOOLS.map((t) => (
                <Tooltip key={t.label}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={t.label}
                      // Keep the selection the tool acts on.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => run(t.op)}
                      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
                    >
                      {t.icon}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t.label}
                    {t.keys && (
                      <KbdGroup>
                        {t.keys.map((k) => (
                          <Kbd key={k}>{k}</Kbd>
                        ))}
                      </KbdGroup>
                    )}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </TooltipProvider>
        )}
      </div>
      <Textarea
        ref={setRefs}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={onTextKeyDown}
        onPaste={onPaste}
        hidden={previewing}
        className={cn(
          "rounded-t-none border-0 bg-transparent shadow-none focus-visible:ring-0",
          className,
        )}
        {...props}
      />
      {previewing && (
        <div
          ref={preview}
          tabIndex={0}
          onKeyDown={onBoxKeyDown}
          aria-label="Preview"
          className={cn(
            "overflow-y-auto px-2.5 py-2 text-sm outline-none",
            className,
          )}
        >
          {value.trim() === "" ? (
            <p className="text-muted-foreground">Nothing to preview</p>
          ) : (
            <Markdown source={value} />
          )}
        </div>
      )}
    </div>
  );
}
