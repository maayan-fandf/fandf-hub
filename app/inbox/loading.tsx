// Streamed while /inbox fetches mentions. Matches the header + filter-bar +
// ~5 mention cards shape of the real page.
export default function InboxLoading() {
  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>🏷️</span>
            תיוגים
          </h1>
          <div className="subtitle">
            <span className="skeleton" style={{ width: "12rem", height: "0.9rem" }} />
          </div>
        </div>
      </header>

      <div className="filter-bar" aria-hidden>
        <span className="skeleton" style={{ width: "8rem", height: "2rem" }} />
        <span className="filter-sep" />
        <span className="skeleton" style={{ width: "10rem", height: "2rem" }} />
      </div>

      <ul className="mention-list">
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i} className="mention-card" aria-hidden>
            <div className="mention-head">
              <span className="skeleton" style={{ width: "2rem", height: "2rem", borderRadius: "50%" }} />
              <span className="skeleton" style={{ width: "6rem", height: "0.9rem" }} />
              <span className="skeleton" style={{ width: "5rem", height: "0.8rem" }} />
            </div>
            <div className="mention-body">
              <span className="skeleton" style={{ width: "100%", height: "0.9rem" }} />
              <span className="skeleton" style={{ width: "70%", height: "0.9rem", marginTop: "0.4rem" }} />
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
