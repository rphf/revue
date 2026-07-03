import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { loadTheme, saveTheme, type Theme } from "./theme";
import type { Review } from "./types";
import ReviewPage from "./pages/ReviewPage";

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    window.history.pushState(null, "", to);
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
  return <ReviewList onNavigate={navigate} theme={theme} onToggleTheme={toggleTheme} />;
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button type="button" className="theme-toggle" onClick={onToggle} aria-label="Toggle theme">
      {theme === "dark" ? "☀️" : "🌙"}
    </button>
  );
}

export function StateChip({ state }: { state: Review["state"] }) {
  return <span className={`state-chip state-${state}`}>{state}</span>;
}

function ReviewList({
  onNavigate,
  theme,
  onToggleTheme,
}: {
  onNavigate: (to: string) => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listReviews()
      .then((r) => setReviews(r.reviews))
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="page">
      <header className="topbar">
        <h1 className="brand">revue</h1>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </header>
      <main className="list-main">
        {error && <p className="error">{error}</p>}
        {reviews === null && !error && <p className="muted">Loading…</p>}
        {reviews?.length === 0 && (
          <p className="muted">
            No reviews yet. Open one with <code>revue open</code>.
          </p>
        )}
        {reviews && reviews.length > 0 && (
          <ul className="review-list">
            {reviews.map((r) => (
              <li key={r.id}>
                <button type="button" className="review-item" onClick={() => onNavigate(`/reviews/${r.id}`)}>
                  <span className="review-id">#{r.id}</span>
                  <span className="review-branch">{r.branch || "(no branch)"}</span>
                  <span className="review-args">{r.sourceArgs.join(" ") || "working tree"}</span>
                  <StateChip state={r.state} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
