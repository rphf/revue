import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface FileStepperProps {
  // Where the file on screen sits in the diff, from 0; -1 for a file
  // the diff does not list, shown for its outdated threads.
  index: number;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  viewedCount: number;
  onPrev: () => void;
  onNext: () => void;
}

// The strip over the diff in focused mode: which file of how many, a
// step up or down the list, and how far the review has come.
export default function FileStepper({
  index,
  total,
  hasPrev,
  hasNext,
  viewedCount,
  onPrev,
  onNext,
}: FileStepperProps) {
  return (
    <nav
      className="flex h-9 shrink-0 items-center gap-1 border-b px-2 text-xs"
      aria-label="Files"
      data-testid="file-stepper"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Previous file"
            disabled={!hasPrev}
            onClick={onPrev}
          >
            <ChevronUpIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Previous file <Kbd>K</Kbd>
        </TooltipContent>
      </Tooltip>
      <span className="tabular-nums" data-testid="file-position">
        {index < 0
          ? `Outdated threads, not in the diff of ${total} files`
          : `File ${index + 1} of ${total}`}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Next file"
            disabled={!hasNext}
            onClick={onNext}
          >
            <ChevronDownIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Next file <Kbd>J</Kbd>
        </TooltipContent>
      </Tooltip>
      <span className="ml-auto text-muted-foreground tabular-nums">
        {viewedCount} of {total} viewed · <Kbd>V</Kbd> marks viewed and moves on
      </span>
    </nav>
  );
}
