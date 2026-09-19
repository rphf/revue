import { useState } from "react";
import type { Verdict } from "../types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

export interface SubmitDialogProps {
  draftCount: number;
  onSubmit: (verdict: Verdict, summary: string) => Promise<void>;
  onClose: () => void;
}

const verdicts: { value: Verdict; label: string; hint: string }[] = [
  { value: "comment", label: "Comment", hint: "Feedback without a verdict" },
  {
    value: "request_changes",
    label: "Request changes",
    hint: "The agent should implement the comments",
  },
  {
    value: "approve",
    label: "Approve",
    hint: "Done; the review becomes read-only for the agent",
  },
];

// Submit review with a verdict and optional summary (R5). A zero-
// comment, verdict-only submission is legal. Submit-in-flight disables
// the button; server errors show inline and re-enable it.
export default function SubmitDialog({
  draftCount,
  onSubmit,
  onClose,
}: SubmitDialogProps) {
  const [verdict, setVerdict] = useState<Verdict>("comment");
  const [summary, setSummary] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(verdict, summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(false);
      return;
    }
    setPending(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Submit review</DialogTitle>
          <DialogDescription>
            {draftCount === 0
              ? "No pending comments — a verdict-only submission."
              : `Publishing ${draftCount} draft comment${draftCount === 1 ? "" : "s"}.`}
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={verdict}
          onValueChange={(v) => setVerdict(v as Verdict)}
          className="gap-1.5"
        >
          {verdicts.map((v) => (
            <Label
              key={v.value}
              htmlFor={`verdict-${v.value}`}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50 has-data-checked:border-foreground/30 has-data-checked:bg-muted/60"
            >
              <RadioGroupItem
                value={v.value}
                id={`verdict-${v.value}`}
                className="mt-0.5"
              />
              <span className="grid gap-0.5">
                <span className="font-medium">{v.label}</span>
                <span className="text-xs text-muted-foreground">{v.hint}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
        <Textarea
          placeholder="Summary (optional)"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
        />
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={pending}
          >
            {pending ? "Submitting…" : "Submit review"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
