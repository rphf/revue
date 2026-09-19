import { CircleAlertIcon } from "lucide-react";
import type { RichDoc } from "@/lib/richDiff";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

// The rendered side of a markdown file: sanitized HTML per block, with
// the changed blocks marked in the diff colors.
export default function RichMarkdown({ doc }: { doc: RichDoc }) {
  if (doc.status === "loading") {
    return (
      <div className="space-y-3 px-6 py-5" aria-busy="true">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (doc.status === "error") {
    return (
      <p
        className="flex items-center gap-2 px-6 py-4 font-sans text-sm text-destructive"
        role="alert"
      >
        <CircleAlertIcon className="size-4" />
        {doc.message}
      </p>
    );
  }
  return (
    <article className="markdown markdown-doc" data-testid="rich-markdown">
      {doc.blocks.map((block, i) => (
        <div
          key={i}
          className={cn(
            "rich-block",
            block.change === "added" && "rich-added",
            block.change === "removed" && "rich-removed",
          )}
          data-change={block.change}
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      ))}
    </article>
  );
}
