import { useCallback, useEffect, useMemo, useState } from "react";
import DiffPage from "./pages/DiffPage";
import { argsFromSearch } from "./lib/diffArgs";
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
  useEffect(() => saveTheme(theme), [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const search = href.includes("?") ? href.slice(href.indexOf("?")) : "";
  const argsKey = argsFromSearch(search).join("\u0000");
  const args = useMemo(
    () => (argsKey === "" ? [] : argsKey.split("\u0000")),
    [argsKey],
  );

  return (
    <DiffPage
      args={args}
      theme={theme}
      onToggleTheme={toggleTheme}
      onNavigate={navigate}
    />
  );
}
