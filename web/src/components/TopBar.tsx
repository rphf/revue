import type { ReactNode } from "react";
import {
  CircleSlashIcon,
  Columns2Icon,
  EllipsisIcon,
  HistoryIcon,
  MessageSquareTextIcon,
  RotateCcwIcon,
  Rows3Icon,
  SendIcon,
} from "lucide-react";
import type { Theme } from "../theme";
import type { Review, RoundSummary } from "../types";
import type { DiffStyle } from "./DiffView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import ReviewSwitcher from "./ReviewSwitcher";
import RoundSwitcher from "./RoundSwitcher";
import StateBadge from "./StateBadge";
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

export interface TopBarProps {
  review?: Review;
  rounds: RoundSummary[];
  currentSeq: number | null;
  latestSeq: number | null;
  roundBusy: boolean;
  onSelectRound: (seq: number) => void;
  threadCount: number;
  panelOpen: boolean;
  onTogglePanel: () => void;
  draftCount: number;
  onSubmit: () => void;
  onClose: () => void;
  onReopen: () => void;
  diffStyle: DiffStyle;
  onDiffStyleChange: (style: DiffStyle) => void;
  theme: Theme;
  onToggleTheme: () => void;
  onNavigate: (to: string) => void;
}

// One bar for the whole review: what is being reviewed on the left,
// how to look at it and what to do with it on the right.
export default function TopBar({
  review,
  rounds,
  currentSeq,
  latestSeq,
  roundBusy,
  onSelectRound,
  threadCount,
  panelOpen,
  onTogglePanel,
  draftCount,
  onSubmit,
  onClose,
  onReopen,
  diffStyle,
  onDiffStyleChange,
  theme,
  onToggleTheme,
  onNavigate,
}: TopBarProps) {
  const state = review?.state ?? "open";
  const pastRound =
    currentSeq !== null && latestSeq !== null && currentSeq !== latestSeq;

  return (
    <TopBarShell>
      <Brand />
      <Separator orientation="vertical" className="mx-1 h-5!" />
      <ReviewSwitcher current={review} onNavigate={onNavigate} />
      {review && <StateBadge state={review.state} />}
      {review && currentSeq !== null && (
        <>
          <Separator orientation="vertical" className="mx-1 h-5!" />
          <RoundSwitcher
            rounds={rounds}
            current={currentSeq}
            disabled={roundBusy}
            onSelect={onSelectRound}
          />
        </>
      )}
      {pastRound && (
        <Badge variant="secondary" className="gap-1 text-renamed">
          <HistoryIcon />
          viewing a past round
        </Badge>
      )}

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

        {review && state === "open" ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More">
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onSelect={onClose}>
                  <CircleSlashIcon />
                  Close review
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              className="ml-1"
              data-testid="open-submit"
              onClick={onSubmit}
            >
              <SendIcon />
              Submit review
              {draftCount > 0 && (
                <span className="rounded-full bg-primary-foreground/20 px-1.5 text-[11px] tabular-nums">
                  {draftCount}
                </span>
              )}
            </Button>
          </>
        ) : review ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-1"
            onClick={onReopen}
          >
            <RotateCcwIcon />
            Reopen review
          </Button>
        ) : null}
      </div>
    </TopBarShell>
  );
}
