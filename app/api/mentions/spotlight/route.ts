import { NextResponse } from "next/server";
import { getMyMentions, type MentionItem } from "@/lib/appsScript";

/**
 * Spotlight feed — backs the global "you were tagged" bar in the layout.
 *
 * The bar's design intent: surface the SINGLE most-recent unresolved
 * mention prominently above all the other hub noise, until the user
 * acknowledges it. We return the top N (not just 1) so the client can
 * skip past locally-dismissed ids without a round-trip — e.g. after the
 * user clicked through to #1 yesterday, today #2 becomes the spotlight
 * even if #1 still isn't formally resolved.
 *
 * Reuses getMyMentions() (same path as /api/mentions/count + /inbox);
 * no extra Sheets call when both endpoints fire on the same render.
 */
const SPOTLIGHT_LIMIT = 10;

type SpotlightMention = Pick<
  MentionItem,
  | "comment_id"
  | "thread_root_id"
  | "parent_id"
  | "project"
  | "author_email"
  | "author_name"
  | "body"
  | "timestamp"
  | "deep_link"
>;

export async function GET() {
  try {
    const data = await getMyMentions();
    const open = data.mentions
      .filter((m) => !m.resolved)
      // Newest-first. timestamps are ISO strings — lexicographic sort
      // matches chronological order, so no Date parsing on the hot path.
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, SPOTLIGHT_LIMIT)
      .map<SpotlightMention>((m) => ({
        comment_id: m.comment_id,
        thread_root_id: m.thread_root_id,
        parent_id: m.parent_id,
        project: m.project,
        author_email: m.author_email,
        author_name: m.author_name,
        body: m.body,
        timestamp: m.timestamp,
        deep_link: m.deep_link,
      }));
    return NextResponse.json({ mentions: open });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
