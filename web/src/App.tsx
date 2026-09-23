import { useCallback, useEffect, useMemo, useState } from "react";
import DiffPage from "./pages/DiffPage";
import { argsForKey, argsFromSearch, keyForArgs } from "./lib/diffArgs";
import { loadTheme, saveTheme, type Theme } from "./theme";

export interface NavigateOptions {
  replace?: boolean;
}

function useLocation() {
  const read = () => window.location.pathname + window.location.search;
  const [href, setHref] = useState(read);
  useEffect(() => {
    const onPop = () => setHref(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string, opts?: NavigateOptions) => {
    if (opts?.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setHref(to);
  }, []);
  return { href, navigate };
}

// One page: the diff named by the URL's `arg` parameters, the working
// tree against HEAD when there are none.
export default function App() {
  const { href, navigate } = useLocation();
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    saveTheme(next);
  }, [theme]);

  // The arguments keep their identity while the URL names the same
  // list, so a navigation that changes nothing refetches nothing.
  const search = href.includes("?") ? href.slice(href.indexOf("?")) : "";
  const argsKey = keyForArgs(argsFromSearch(search));
  const args = useMemo(() => argsForKey(argsKey), [argsKey]);

  return (
    <DiffPage
      args={args}
      theme={theme}
      onToggleTheme={toggleTheme}
      onNavigate={navigate}
    />
  );
}
