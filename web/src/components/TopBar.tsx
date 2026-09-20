import type { ReactNode } from "react";
import {
  Columns2Icon,
  MessageSquareTextIcon,
  Rows3Icon,
  SendIcon,
} from "lucide-react";
import type { Theme } from "../theme";
import type { DiffStyle } from "./DiffView";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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

export function Brand() {
  return (
    <div className="flex items-center gap-2 pl-1 font-medium tracking-tight">
      <BrandMark />
      <span>revue</span>
    </div>
  );
}

export function TopBarShell({ children }: { children: ReactNode }) {
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

export interface TopBarProps {
  branch?: string;
  args: string[];
  onNavigate: (to: string) => void;
  pulse: number;
  threadCount: number;
  panelOpen: boolean;
  onTogglePanel: () => void;
  draftCount: number;
  onSend: () => void;
  diffStyle: DiffStyle;
  onDiffStyleChange: (style: DiffStyle) => void;
  theme: Theme;
  onToggleTheme: () => void;
}

// One bar for the page: what is shown on the left, how to look at it
// and what to do with it on the right.
export default function TopBar({
  branch,
  args,
  onNavigate,
  pulse,
  threadCount,
  panelOpen,
  onTogglePanel,
  draftCount,
  onSend,
  diffStyle,
  onDiffStyleChange,
  theme,
  onToggleTheme,
}: TopBarProps) {
  return (
    <TopBarShell>
      <Brand />
      <Separator orientation="vertical" className="mx-1 h-5!" />
      <DiffPicker branch={branch} args={args} onNavigate={onNavigate} />
      <LiveDot pulse={pulse} />

      <div className="ml-auto flex items-center gap-1">
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
          <TooltipContent>Threads</TooltipContent>
        </Tooltip>

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
            <TooltipContent>Split view</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroupItem value="unified" aria-label="Unified view">
                <Rows3Icon />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>Unified view</TooltipContent>
          </Tooltip>
        </ToggleGroup>

        <ThemeToggle theme={theme} onToggle={onToggleTheme} />

        <Button
          size="sm"
          className="ml-1"
          data-testid="open-send"
          onClick={onSend}
        >
          <SendIcon />
          Send
          {draftCount > 0 && (
            <span className="rounded-full bg-primary-foreground/20 px-1.5 text-[11px] tabular-nums">
              {draftCount}
            </span>
          )}
        </Button>
      </div>
    </TopBarShell>
  );
}
