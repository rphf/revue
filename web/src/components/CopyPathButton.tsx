import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

// Copies the file's path, as GitHub's button after the name does;
// a check for a moment says it worked.
export default function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="text-muted-foreground hover:text-foreground"
      aria-label={copied ? "Copied" : `Copy the path of ${path}`}
      title={copied ? "Copied" : "Copy the path"}
      onClick={() => {
        void navigator.clipboard?.writeText(path).then(() => setCopied(true));
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}
