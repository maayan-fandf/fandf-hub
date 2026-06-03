import LoadingVideo from "@/components/LoadingVideo";

// Streamed while /morning fetches the feed.
export default function MorningLoading() {
  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>☀️</span>
            סיכום בוקר
          </h1>
        </div>
      </header>
      <LoadingVideo label="טוען את הסיכום…" />
    </main>
  );
}
