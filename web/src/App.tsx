import { useCallback, useEffect, useState } from "react";
import { TerminalIcon } from "lucide-react";
import { api } from "./api";
import ReviewPage from "./pages/ReviewPage";
import { loadTheme, saveTheme, type Theme } from "./theme";
import type { Review } from "./types";
import ThemeToggle from "./components/ThemeToggle";
import { Brand, TopBarShell } from "./components/TopBar";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";

export interface NavigateOptions {
  replace?: boolean;
}

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string, opts?: NavigateOptions) => {
    if (opts?.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setPath(to);
  }, []);
  return { path, navigate };
}

export default function App() {
  const { path, navigate } = usePath();
  const [theme, setTheme] = useState<Theme>(loadTheme);
  useEffect(() => saveTheme(theme), [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const reviewMatch = path.match(/^\/reviews\/(\d+)$/);
  if (reviewMatch) {
    return (
      <ReviewPage
        reviewId={Number(reviewMatch[1])}
        theme={theme}
        onToggleTheme={toggleTheme}
        onNavigate={navigate}
      />
    );
  }
  return <Home navigate={navigate} theme={theme} onToggleTheme={toggleTheme} />;
}

// There is no list page: the root sends the browser to the newest
// review, where the switcher in the top bar lists all of them. Only an
// empty database keeps the reader here.
function Home({
  navigate,
  theme,
  onToggleTheme,
}: {
  navigate: (to: string, opts?: NavigateOptions) => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listReviews()
      .then((r) => {
        if (!cancelled) setReviews(r.reviews);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const newest = reviews?.reduce<Review | null>(
    (best, r) => (best === null || r.id > best.id ? r : best),
    null,
  );
  useEffect(() => {
    if (newest) navigate(`/reviews/${newest.id}`, { replace: true });
  }, [newest, navigate]);

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TopBarShell>
          <Brand />
          <div className="ml-auto">
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          </div>
        </TopBarShell>
        <main className="grid flex-1 place-items-center p-6">
          {error ? (
            <p className="text-destructive" role="alert">
              {error}
            </p>
          ) : reviews === null || newest ? (
            <div className="w-full max-w-sm space-y-3" aria-busy="true">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          ) : (
            <div className="w-full max-w-sm rounded-xl border bg-card p-6 text-center shadow-xs">
              <div className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
                <TerminalIcon className="size-5" />
              </div>
              <h1 className="font-medium">No reviews yet</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Open one from a repository that has changes:
              </p>
              <pre className="mt-3 rounded-md bg-muted px-3 py-2 text-left font-mono text-xs">
                revue open
              </pre>
            </div>
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}
