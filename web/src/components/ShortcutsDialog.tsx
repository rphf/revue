import { Fragment } from "react";
import { IS_MAC } from "@/lib/platform";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";

const MOD = IS_MAC ? "⌘" : "Ctrl";
const SHIFT = IS_MAC ? "⇧" : "Shift";

interface Shortcut {
  // Each entry is one key combination; several are alternatives.
  keys: string[][];
  label: string;
}

interface Section {
  title: string;
  shortcuts: Shortcut[];
}

// Every shortcut in the app, where it works. The handlers live with
// the views they act on; this list is what the reviewer reads.
const SECTIONS: Section[] = [
  {
    title: "Anywhere",
    shortcuts: [
      { keys: [[MOD, "B"]], label: "Show or hide the files" },
      { keys: [[MOD, "I"]], label: "Show or hide the threads" },
      {
        keys: [[MOD, SHIFT, "↵"]],
        label: "Send the drafts, or write a note if there are none",
      },
      { keys: [["?"]], label: "Show these shortcuts" },
    ],
  },
  {
    title: "Diff",
    shortcuts: [
      { keys: [["W"]], label: "Hide or show whitespace changes" },
      { keys: [["|"]], label: "Switch between split and unified views" },
    ],
  },
  {
    title: "Comment and note",
    shortcuts: [
      {
        keys: [[MOD, "↵"]],
        label: "Submit the comment, or send with the note",
      },
      { keys: [["Esc"]], label: "Cancel the comment" },
      { keys: [[MOD, "E"]], label: "Code" },
      { keys: [[MOD, "K"]], label: "Link" },
      { keys: [[MOD, SHIFT, "."]], label: "Quote" },
      { keys: [[MOD, SHIFT, "8"]], label: "Bulleted list" },
      { keys: [[MOD, SHIFT, "7"]], label: "Numbered list" },
      { keys: [[MOD, SHIFT, "P"]], label: "Switch between Write and Preview" },
    ],
  },
  {
    title: "Outdated thread",
    shortcuts: [
      { keys: [["J"]], label: "Next outdated thread" },
      { keys: [["K"]], label: "Previous outdated thread" },
      { keys: [["Esc"]], label: "Back to the diff" },
    ],
  },
  {
    title: "Image preview",
    shortcuts: [
      { keys: [["+"], ["-"]], label: "Zoom in or out" },
      { keys: [["0"]], label: "Fit to the view" },
      { keys: [["1"]], label: "Actual size" },
      { keys: [["←"], ["→"]], label: "Previous or next image" },
    ],
  },
];

export interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ShortcutsDialog({
  open,
  onOpenChange,
}: ShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Single keys do nothing while you type in a text box.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {SECTIONS.map((section) => (
            <section key={section.title} aria-label={section.title}>
              <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">
                {section.title}
              </h3>
              <dl className="flex flex-col gap-1.5 text-sm">
                {section.shortcuts.map((s) => (
                  <div
                    key={s.label}
                    className="flex items-center justify-between gap-4"
                  >
                    <dt>{s.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1 text-muted-foreground">
                      {s.keys.map((combo, i) => (
                        <Fragment key={combo.join("+")}>
                          {i > 0 && <span className="text-xs">/</span>}
                          <KbdGroup>
                            {combo.map((k) => (
                              <Kbd key={k}>{k}</Kbd>
                            ))}
                          </KbdGroup>
                        </Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
