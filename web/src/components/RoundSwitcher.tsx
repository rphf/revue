import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RoundSummary } from "../types";

export interface RoundSwitcherProps {
  rounds: RoundSummary[];
  current: number; // seq being shown
  disabled?: boolean;
  onSelect: (seq: number) => void;
}

// Navigate the review's frozen rounds (R8): any prior round renders
// exactly the patch it was reviewed against. Disabled while a round
// fetch is in flight.
export default function RoundSwitcher({
  rounds,
  current,
  disabled,
  onSelect,
}: RoundSwitcherProps) {
  if (rounds.length <= 1) {
    return (
      <span className="text-xs text-muted-foreground tabular-nums">
        round {current}
      </span>
    );
  }
  const first = rounds[0].seq;
  const last = rounds[rounds.length - 1].seq;
  return (
    <div className="flex items-center" data-testid="round-switcher">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous round"
        disabled={disabled || current <= first}
        onClick={() => onSelect(current - 1)}
      >
        <ChevronLeftIcon />
      </Button>
      <Select
        value={String(current)}
        disabled={disabled}
        onValueChange={(v) => onSelect(Number(v))}
      >
        <SelectTrigger
          size="sm"
          aria-label="Round"
          className="h-7 gap-1 border-transparent bg-transparent px-1.5 text-xs shadow-none tabular-nums hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" position="popper">
          {rounds.map((r) => (
            <SelectItem key={r.seq} value={String(r.seq)}>
              round {r.seq}
              {r.seq === last ? " (latest)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Next round"
        disabled={disabled || current >= last}
        onClick={() => onSelect(current + 1)}
      >
        <ChevronRightIcon />
      </Button>
    </div>
  );
}
