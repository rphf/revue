import type { ReactNode } from "react";
import {
  BookMarkedIcon,
  Columns2Icon,
  KeyboardIcon,
  MessageSquarePlusIcon,
  MessageSquareTextIcon,
  PanelLeftIcon,
  Rows3Icon,
  SendIcon,
  SpaceIcon,
} from "lucide-react";
import type { Theme } from "../theme";
import type { DiffStyle } from "./DiffView";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import DiffPicker from "./DiffPicker";
import ThemeToggle from "./ThemeToggle";

// The mark, same drawing as public/favicon.svg: a hunk with its last
// line checked off. Drawn inline so it takes the tile's colors.
function BrandMark() {
  return (
    <svg
      viewBox="0 0 32 32"
      className="size-6 rounded-md bg-foreground text-background"
      aria-hidden="true"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 10h14M9 16h9M9 22h6" />
        <path d="M17.5 21.5l2.6 2.6 5.4-5.6" />
      </g>
    </svg>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 pl-1 font-medium tracking-tight">
      <BrandMark />
      <span>revue</span>
    </div>
  );
}

function TopBarShell({ children }: { children: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
      {children}
    </header>
  );
}

// The diff follows the working tree; the dot says so, and rings once
// each time the page picked up a change. The ring remounts on every
// pulse so its one-shot animation restarts.
function LiveDot({ pulse }: { pulse: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="relative mx-1 inline-flex size-2 shrink-0"
          role="img"
          aria-label="Live"
          data-testid="live-dot"
        >
          <span
            key={pulse}
            className={cn(
              "absolute inset-0 rounded-full bg-added",
              pulse > 0 && "live-pulse",
            )}
          />
          <span className="relative inline-flex size-2 rounded-full bg-added" />
        </span>
      </TooltipTrigger>
      <TooltipContent>Follows the working tree</TooltipContent>
    </Tooltip>
  );
}

// A shortcut as the modifier key, then the rest.
function Shortcut({ keys }: { keys: string[] }) {
  return (
    <KbdGroup>
      <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </KbdGroup>
  );
}

export interface TopBarProps {
  repo?: string;
  branch?: string;
  args: string[];
  onNavigate: (to: string) => void;
  pulse: number;
  threadCount: number;
  panelOpen: boolean;
  onTogglePanel: () => void;
  treeOpen: boolean;
  onToggleTree: () => void;
  draftCount: number;
  // Sends the drafts at once, without a note.
  onSendNow: () => void;
  // Opens the threads panel on the composer, to send with a note.
  onCompose: () => void;
  sending: boolean;
  diffStyle: DiffStyle;
  onDiffStyleChange: (style: DiffStyle) => void;
  hideSpace: boolean;
  onToggleHideSpace: () => void;
  onShowShortcuts: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

// One bar for the page: what is shown on the left, how to look at it
// and what to do with it on the right.
export default function TopBar({
  repo,
  branch,
  args,
  onNavigate,
  pulse,
  threadCount,
  panelOpen,
  onTogglePanel,
  treeOpen,
  onToggleTree,
  draftCount,
  onSendNow,
  onCompose,
  sending,
  diffStyle,
  onDiffStyleChange,
  hideSpace,
  onToggleHideSpace,
  onShowShortcuts,
  theme,
  onToggleTheme,
}: TopBarProps) {
  return (
    <TopBarShell>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={treeOpen ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={`${treeOpen ? "Hide" : "Show"} files`}
            aria-pressed={treeOpen}
            onClick={onToggleTree}
          >
            <PanelLeftIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Files <Shortcut keys={["B"]} />
        </TooltipContent>
      </Tooltip>
      <Brand />
      <Separator orientation="vertical" className="mx-1 h-5!" />
      {repo && (
        <span
          className="flex min-w-0 items-center gap-1.5 px-1 text-sm font-medium"
          data-testid="repo-name"
        >
          <BookMarkedIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{repo}</span>
        </span>
      )}
      <DiffPicker branch={branch} args={args} onNavigate={onNavigate} />
      <LiveDot pulse={pulse} />

      {/* How the diff looks, then the page's theme, then the review:
          the threads and sending them, which opens the threads too. */}
      <div className="ml-auto flex items-center gap-1.5">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={diffStyle}
          onValueChange={(v) => {
            if (v) onDiffStyleChange(v as DiffStyle);
          }}
          aria-label="Diff layout"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroupItem value="split" aria-label="Split view">
                <Columns2Icon />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>
              Split view <Kbd>|</Kbd>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroupItem value="unified" aria-label="Unified view">
                <Rows3Icon />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>
              Unified view <Kbd>|</Kbd>
            </TooltipContent>
          </Tooltip>
        </ToggleGroup>

        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              variant="outline"
              size="sm"
              className="rounded-lg px-2"
              pressed={hideSpace}
              onPressedChange={onToggleHideSpace}
              aria-label={`${hideSpace ? "Show" : "Hide"} whitespace changes`}
            >
              <SpaceIcon />
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>
            {hideSpace ? "Show" : "Hide"} whitespace <Kbd>W</Kbd>
          </TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="mx-1 h-5!" />
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Keyboard shortcuts"
              onClick={onShowShortcuts}
            >
              <KeyboardIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Keyboard shortcuts <Kbd>?</Kbd>
          </TooltipContent>
        </Tooltip>
        <Separator orientation="vertical" className="mx-1 h-5!" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={panelOpen ? "secondary" : "ghost"}
              size="sm"
              aria-label={`${panelOpen ? "Hide" : "Show"} threads`}
              aria-pressed={panelOpen}
              onClick={onTogglePanel}
            >
              <MessageSquareTextIcon />
              {threadCount > 0 && (
                <span className="tabular-nums">{threadCount}</span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Threads <Shortcut keys={["I"]} />
          </TooltipContent>
        </Tooltip>

        {/* One click sends the drafts as they are; the second half
            opens the composer to add a note. Without drafts there is
            nothing to send at once, so both halves open the composer. */}
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                className="rounded-r-none"
                data-testid="send-now"
                disabled={sending}
                onClick={draftCount > 0 ? onSendNow : onCompose}
              >
                <SendIcon />
                {sending ? "Sending…" : "Send"}
                {draftCount > 0 && (
                  <span className="rounded-full bg-primary-foreground/20 px-1.5 text-[11px] tabular-nums">
                    {draftCount}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {draftCount > 0 ? "Send directly" : "Write a note"}{" "}
              <Shortcut keys={[IS_MAC ? "⇧" : "Shift", "↵"]} />
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                className="rounded-l-none border-l border-primary-foreground/20 px-2"
                aria-label="Send with a note"
                data-testid="open-send"
                onClick={onCompose}
              >
                <MessageSquarePlusIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Send with a note</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TopBarShell>
  );
}
