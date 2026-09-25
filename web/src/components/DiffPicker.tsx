import { useMemo, useState, type ReactNode } from "react";
import { CheckIcon, ChevronsUpDownIcon, GitBranchIcon } from "lucide-react";
import {
  diffLabel,
  LAST_SEND_REF,
  pathForArgs,
  sameArgs,
} from "@/lib/diffArgs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";

const RECENT_KEY = "revue-recent-diffs";
const RECENT_MAX = 5;

const PRESETS: { args: string[]; label: string; hint: string }[] = [
  {
    args: [],
    label: "Uncommitted changes",
    hint: "working tree against HEAD, untracked files included",
  },
  { args: ["--staged"], label: "Staged changes", hint: "git diff --staged" },
  {
    args: [LAST_SEND_REF],
    label: "Since my last send",
    hint: "what changed in the working tree after you last sent",
  },
];

function loadRecent(): string[][] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is string[] =>
        Array.isArray(entry) && entry.every((v) => typeof v === "string"),
    );
  } catch {
    return [];
  }
}

function remember(args: string[]): void {
  try {
    const next = [args, ...loadRecent().filter((r) => !sameArgs(r, args))];
    localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, RECENT_MAX)));
  } catch {
    // Not remembering is fine.
  }
}

function Row({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent",
        active && "bg-accent/60",
      )}
      data-checked={active}
      onClick={onClick}
    >
      <span className="grid min-w-0 flex-1 gap-0.5">{children}</span>
      <CheckIcon
        className={cn("mt-0.5 size-4 shrink-0", !active && "invisible")}
      />
    </button>
  );
}

export interface DiffPickerProps {
  branch?: string;
  args: string[];
  onNavigate: (to: string) => void;
}

// What the page shows: the branch and the diff, with the two presets,
// the diffs looked at recently, and a box for any git diff arguments.
// Choosing one changes the URL; the page follows.
export default function DiffPicker({
  branch,
  args,
  onNavigate,
}: DiffPickerProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const recent = useMemo(
    () =>
      open
        ? loadRecent().filter((r) => !PRESETS.some((p) => sameArgs(p.args, r)))
        : [],
    [open],
  );

  const choose = (next: string[]) => {
    setOpen(false);
    setInput("");
    if (!PRESETS.some((p) => sameArgs(p.args, next))) remember(next);
    if (!sameArgs(next, args)) onNavigate(pathForArgs(next));
  };

  const submit = () => {
    const parts = input.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0) choose(parts);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-[45vw] gap-1.5 px-2 font-medium"
          aria-label="Change diff"
        >
          <GitBranchIcon className="text-muted-foreground" />
          {branch && <span className="truncate">{branch}</span>}
          <span className="text-muted-foreground">·</span>
          <span className="truncate font-mono text-xs font-normal">
            {diffLabel(args)}
          </span>
          <ChevronsUpDownIcon className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[400px] p-2">
        <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
          Show
        </p>
        <div className="grid gap-0.5">
          {PRESETS.map((p) => (
            <Row
              key={p.label}
              active={sameArgs(p.args, args)}
              onClick={() => choose(p.args)}
            >
              <span>{p.label}</span>
              <span className="text-xs text-muted-foreground">{p.hint}</span>
            </Row>
          ))}
          {recent.map((r) => (
            <Row
              key={r.join("\u0000")}
              active={sameArgs(r, args)}
              onClick={() => choose(r)}
            >
              <span className="truncate font-mono text-xs">{r.join(" ")}</span>
            </Row>
          ))}
        </div>
        <Separator className="my-2" />
        <form
          className="flex items-center gap-1.5 px-1 pb-1"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            aria-label="git diff arguments"
            placeholder="git diff arguments, e.g. main...HEAD -- web"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="h-8 font-mono text-xs"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={input.trim() === ""}
          >
            Show
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
