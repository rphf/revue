import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export interface LoadingBlocksProps {
  // Tailwind width and height classes, one bar each, top to bottom.
  bars: string[];
  label?: string;
  className?: string;
  "data-testid"?: string;
}

// Placeholder bars for content still loading, announced as busy.
export default function LoadingBlocks({
  bars,
  label,
  className,
  "data-testid": testId,
}: LoadingBlocksProps) {
  return (
    <div
      className={cn("space-y-3", className)}
      data-testid={testId}
      aria-busy="true"
    >
      {label && <span className="sr-only">{label}</span>}
      {bars.map((bar, i) => (
        <Skeleton key={i} className={bar} />
      ))}
    </div>
  );
}
