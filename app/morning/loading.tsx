// Streamed while /morning fetches the feed. Matches header + severity chips
// + ~4 project alert cards shape of the real page.
export default function MorningLoading() {
  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>☀️</span>
            בוקר
          </h1>
          <div className="subtitle">
            <span className="skeleton" style={{ width: "18rem", height: "0.9rem" }} />
          </div>
        </div>
      </header>

      <div className="morning-filter-bar" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="skeleton" style={{ width: "5rem", height: "2rem" }} />
        ))}
      </div>

      <ul className="morning-list">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="morning-card" aria-hidden>
            <div className="morning-card-head">
              <div className="morning-card-title">
                <span className="skeleton" style={{ width: "10rem", height: "1.1rem" }} />
              </div>
              <div className="morning-card-meta">
                <span className="skeleton" style={{ width: "8rem", height: "0.9rem" }} />
                <span className="skeleton" style={{ width: "8rem", height: "0.9rem" }} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
