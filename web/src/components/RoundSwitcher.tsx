import type { RoundSummary } from "../types";

export interface RoundSwitcherProps {
  rounds: RoundSummary[];
  current: number; // seq being shown
  disabled?: boolean;
  onSelect: (seq: number) => void;
}

// Navigate the review's frozen rounds (R8): any prior round renders
// exactly the patch it was reviewed against. Disabled while a round
// fetch is in flight.
export default function RoundSwitcher({ rounds, current, disabled, onSelect }: RoundSwitcherProps) {
  if (rounds.length <= 1) {
    return <span className="round-label">round {current}</span>;
  }
  const first = rounds[0].seq;
  const last = rounds[rounds.length - 1].seq;
  return (
    <span className="round-switcher" data-testid="round-switcher">
      <button
        type="button"
        className="round-nav"
        aria-label="Previous round"
        disabled={disabled || current <= first}
        onClick={() => onSelect(current - 1)}
      >
        ‹
      </button>
      <select
        aria-label="Round"
        value={current}
        disabled={disabled}
        onChange={(e) => onSelect(Number(e.target.value))}
      >
        {rounds.map((r) => (
          <option key={r.seq} value={r.seq}>
            round {r.seq}
            {r.seq === last ? " (latest)" : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="round-nav"
        aria-label="Next round"
        disabled={disabled || current >= last}
        onClick={() => onSelect(current + 1)}
      >
        ›
      </button>
    </span>
  );
}
