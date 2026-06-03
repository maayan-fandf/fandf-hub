import LoadingVideo from "@/components/LoadingVideo";

// Streamed while /inbox fetches mentions.
export default function InboxLoading() {
  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>🏷️</span>
            תיוגים
          </h1>
        </div>
      </header>
      <LoadingVideo label="טוען תיוגים…" />
    </main>
  );
}
