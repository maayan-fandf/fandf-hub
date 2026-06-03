import LoadingVideo from "@/components/LoadingVideo";

// Renders instantly while the server fetches home-page data. The video
// replaces the earlier skeleton placeholders so the wait reads as
// "something's happening" instead of a stack of grey shimmer bars.
// Header + h1 stay so the page identity is obvious at first paint.
export default function HomeLoading() {
  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>📂</span>
            פרויקטים
          </h1>
        </div>
      </header>
      <LoadingVideo label="טוען פרויקטים…" />
    </main>
  );
}
