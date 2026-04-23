// Streamed while /projects/[project] fetches (5 parallel API calls —
// typically the slowest route). Matches header + 3 stat tiles + 3 preview
// sections shape.
export default function ProjectLoading() {
  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>🏢</span>
            <span className="skeleton" style={{ width: "12rem", height: "1.6rem", display: "inline-block", verticalAlign: "middle" }} />
          </h1>
          <div className="subtitle">
            <span className="skeleton" style={{ width: "8rem", height: "0.9rem" }} />
          </div>
        </div>
      </header>

      <div className="stats-grid">
        {(["tasks", "mentions", "comments"] as const).map((v) => (
          <div key={v} className={`stat-tile stat-tile-${v}`}>
            <span className="skeleton" style={{ width: "3rem", height: "1.8rem" }} />
            <span className="skeleton" style={{ width: "8rem", height: "0.8rem", marginTop: "0.4rem" }} />
          </div>
        ))}
      </div>

      <div className="project-sections">
        {[0, 1, 2].map((i) => (
          <section key={i} className="project-section" aria-hidden>
            <div className="section-head">
              <h2>
                <span className="skeleton" style={{ width: "6rem", height: "1.1rem" }} />
              </h2>
            </div>
            <ul className="compact-list">
              {[0, 1, 2].map((j) => (
                <li key={j} className="compact-task">
                  <div className="compact-task-title">
                    <span className="skeleton" style={{ width: "90%", height: "0.9rem" }} />
                  </div>
                  <div className="compact-task-meta">
                    <span className="skeleton" style={{ width: "4rem", height: "0.8rem" }} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
