import { BellIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { askNotifyPermission } from "@/lib/attention";

// Shown when `revue open` found this tab but could not bring it
// forward. The Allow click is the user action the permission prompt
// needs; the next `revue open` then raises a notification instead.
export default function NotifyBanner({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="status"
      className="fixed top-10 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-popover py-1 pr-1 pl-3 text-xs text-popover-foreground shadow-md"
    >
      <BellIcon className="size-3.5 text-muted-foreground" />
      Allow notifications so revue open can bring this tab forward.
      <Button
        type="button"
        size="xs"
        onClick={() => {
          void askNotifyPermission().finally(onClose);
        }}
      >
        Allow
      </Button>
      <Button type="button" variant="ghost" size="xs" onClick={onClose}>
        Not now
      </Button>
    </div>
  );
}
