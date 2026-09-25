import { useState } from "react";
import { PaletteIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ACCENTS,
  loadAppearance,
  PALETTES,
  saveAppearance,
  type Appearance,
} from "../theme";

function Swatches<K extends string>({
  label,
  colors,
  active,
  onPick,
}: {
  label: string;
  colors: Record<K, string>;
  active: K;
  onPick: (name: K) => void;
}) {
  return (
    <div className="grid gap-1.5" role="radiogroup" aria-label={label}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-2">
        {(Object.entries(colors) as [K, string][]).map(([name, color]) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={name === active}
            aria-label={name}
            title={name}
            className={cn(
              "size-6 rounded-full ring-offset-2 ring-offset-popover outline-none focus-visible:ring-2 focus-visible:ring-ring",
              name === active && "ring-2 ring-foreground",
            )}
            style={{ backgroundColor: color }}
            onClick={() => onPick(name)}
          />
        ))}
      </div>
    </div>
  );
}

// shadcn's gray palette and accent color, switched at runtime.
export default function AppearancePicker() {
  const [look, setLook] = useState(loadAppearance);
  const change = (next: Partial<Appearance>) => {
    const merged = { ...look, ...next };
    setLook(merged);
    saveAppearance(merged);
  };

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Appearance">
              <PaletteIcon />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Appearance</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 gap-3 p-3">
        <Swatches
          label="Palette"
          colors={PALETTES}
          active={look.palette}
          onPick={(palette) => change({ palette })}
        />
        {/* "none" keeps the palette's own primary. */}
        <Swatches
          label="Accent"
          colors={{ none: PALETTES[look.palette], ...ACCENTS }}
          active={look.accent}
          onPick={(accent) => change({ accent })}
        />
      </PopoverContent>
    </Popover>
  );
}
