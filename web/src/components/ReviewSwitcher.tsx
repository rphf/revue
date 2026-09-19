import { useEffect, useState } from "react";
import { ChevronsUpDownIcon } from "lucide-react";
import { api } from "../api";
import type { Review } from "../types";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

function reviewTitle(r: Review): string {
  return r.branch || r.sourceArgs.join(" ") || "working tree";
}

function reviewScope(r: Review): string {
  return r.sourceArgs.length > 0 ? r.sourceArgs.join(" ") : "working tree";
}

const stateDot: Record<Review["state"], string> = {
  open: "bg-added",
  approved: "bg-agent",
  closed: "bg-muted-foreground/40",
};

// The review list lives here instead of on its own page: the current
// review is the trigger, every other review is one keystroke away, and
// the list is fetched when the popover opens so it is never stale.
export default function ReviewSwitcher({
  current,
  onNavigate,
}: {
  current?: Review;
  onNavigate: (to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .listReviews()
      .then((r) => {
        if (cancelled) return;
        setReviews([...r.reviews].sort((a, b) => b.id - a.id));
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-[40vw] gap-1.5 px-2 font-medium"
          aria-label="Switch review"
        >
          {current ? (
            <>
              <span className="text-muted-foreground tabular-nums">
                #{current.id}
              </span>
              <span className="truncate">{reviewTitle(current)}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Reviews</span>
          )}
          <ChevronsUpDownIcon className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[400px] p-0">
        <Command>
          <CommandInput placeholder="Search reviews…" />
          <CommandList>
            <CommandEmpty>
              {error ?? (reviews === null ? "Loading…" : "No reviews")}
            </CommandEmpty>
            {reviews && reviews.length > 0 && (
              <CommandGroup heading="Reviews">
                {reviews.map((r) => (
                  <CommandItem
                    key={r.id}
                    value={`#${r.id} ${reviewTitle(r)} ${reviewScope(r)}`}
                    data-checked={r.id === current?.id}
                    className="items-start gap-2.5 py-2"
                    onSelect={() => {
                      setOpen(false);
                      if (r.id !== current?.id) onNavigate(`/reviews/${r.id}`);
                    }}
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        stateDot[r.state],
                      )}
                      title={r.state}
                    />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <span className="text-muted-foreground tabular-nums">
                          #{r.id}
                        </span>
                        <span className="truncate font-medium">
                          {reviewTitle(r)}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate font-mono">
                          {reviewScope(r)}
                        </span>
                        <span className="ml-auto shrink-0">
                          {timeAgo(r.updatedAt)}
                        </span>
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
