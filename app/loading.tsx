// Renders instantly while the server fetches home-page data. Matches the
// rough shape of `app/page.tsx`: header + two stat tiles + a stack of
// company-group summaries. Next.js 15 streams this as the fallback.
export default function HomeLoading() {
  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>📂</span>
            פרויקטים
          </h1>
          <div className="subtitle">
            <span className="skeleton" style={{ width: "14rem", height: "0.9rem" }} />
          </div>
        </div>
      </header>

      <div className="stats-grid home-stats">
        <div className="stat-tile stat-tile-tasks">
          <span className="skeleton" style={{ width: "3rem", height: "1.8rem" }} />
          <span className="skeleton" style={{ width: "8rem", height: "0.8rem", marginTop: "0.4rem" }} />
        </div>
        <div className="stat-tile stat-tile-mentions">
          <span className="skeleton" style={{ width: "3rem", height: "1.8rem" }} />
          <span className="skeleton" style={{ width: "8rem", height: "0.8rem", marginTop: "0.4rem" }} />
        </div>
      </div>

      <div className="company-groups">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="company-group" aria-hidden>
            <div className="company-group-summary" style={{ pointerEvents: "none" }}>
              <span className="skeleton" style={{ width: "10rem", height: "1.1rem" }} />
              <span className="skeleton" style={{ width: "3rem", height: "1.1rem", marginInlineStart: "auto" }} />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
