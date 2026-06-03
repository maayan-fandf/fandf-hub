import LoadingVideo from "@/components/LoadingVideo";

// Streamed while /projects/[project] runs its 5 parallel API calls —
// typically the slowest route in the hub. The video gives it weight.
export default function ProjectLoading() {
  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>🏢</span>
            פרויקט
          </h1>
        </div>
      </header>
      <LoadingVideo label="טוען את הפרויקט…" />
    </main>
  );
}
