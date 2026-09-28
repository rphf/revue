import { useState } from "react";
import type { AgentNote as Note } from "../types";

// Which note the reviewer collapsed, by its time: a newer note opens.
const COLLAPSED_KEY = "revue-agent-note-collapsed";

function readCollapsed(): string | null {
  try {
    return localStorage.getItem(COLLAPSED_KEY);
  } catch {
    return null;
  }
}

export function useNoteCollapsed(note: Note | null): [boolean, () => void] {
  const [collapsedAt, setCollapsedAt] = useState(readCollapsed);
  const collapsed = note !== null && collapsedAt === note.updatedAt;
  const toggle = () => {
    if (!note) return;
    const next = collapsed ? null : note.updatedAt;
    setCollapsedAt(next);
    try {
      if (next === null) localStorage.removeItem(COLLAPSED_KEY);
      else localStorage.setItem(COLLAPSED_KEY, next);
    } catch {
      // Storage may be off; the note then opens on each load.
    }
  };
  return [collapsed, toggle];
}
