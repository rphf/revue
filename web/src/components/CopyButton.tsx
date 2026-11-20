import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

// An icon button that copies `text`; a check for a moment says it
// worked. `label` names the button for screen readers, `title` on hover.
export default function CopyButton({
  text,
  label,
  title,
}: {
  text: string;
  label: string;
  title: string;
}) {
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
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : title}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}
