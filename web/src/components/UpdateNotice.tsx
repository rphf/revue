import { useEffect, useState } from "react";
import {
  ArrowUpCircleIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
} from "lucide-react";
import type { ServerVersion } from "@/lib/useVersion";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const COMMAND = "revue update";
const RELEASES = "https://github.com/rphf/revue/releases";

// A newer release than the running server, with the command that
// installs it and a link to its release notes. A local build never
// reports one.
export default function UpdateNotice({
  version,
}: {
  version: ServerVersion | null;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const latest = version?.latest;
  if (!latest) return null;
  const copy = () => {
    void navigator.clipboard?.writeText(COMMAND).then(() => setCopied(true));
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-added"
          data-testid="update-notice"
        >
          <ArrowUpCircleIcon />
          {latest}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-72 flex-col gap-3 p-3">
        <p className="text-sm">
          revue {latest} is out. This server runs {version.version}.
        </p>
        <div className="flex items-center gap-2 rounded-md border bg-muted px-2 py-1">
          <code className="flex-1 font-mono text-xs">{COMMAND}</code>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Copy the command"
            onClick={copy}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Run it in a terminal. It replaces the binary and restarts the running
          servers; this page reconnects on its own.
        </p>
        <Button variant="ghost" size="xs" className="self-start" asChild>
          <a
            href={`${RELEASES}/tag/${encodeURIComponent(latest)}`}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLinkIcon />
            What's new in {latest}
          </a>
        </Button>
      </PopoverContent>
    </Popover>
  );
}
