import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { ReviewState } from "../types";

const tones: Record<ReviewState, string> = {
  open: "border-added/40 bg-added/10 text-added",
  approved: "border-agent/40 bg-agent/10 text-agent",
  closed: "text-muted-foreground",
};

export default function StateBadge({
  state,
  className,
}: {
  state: ReviewState;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("capitalize", tones[state], className)}
    >
      {state}
    </Badge>
  );
}
