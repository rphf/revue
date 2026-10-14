import { useEffect, useState } from "react";
import { api } from "../api";

export interface ServerVersion {
  version: string;
  // Set when a newer release than the running one is out.
  latest?: string;
}

// The running server's version, read once per page.
export function useVersion(): ServerVersion | null {
  const [version, setVersion] = useState<ServerVersion | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getVersion().then(
      (v) => {
        if (!cancelled) setVersion(v);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}
