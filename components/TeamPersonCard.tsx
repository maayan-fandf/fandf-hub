import Link from "next/link";
import Image from "next/image";
import GmailIcon from "@/components/GmailIcon";
import WhatsAppIcon from "@/components/WhatsAppIcon";
import { roleEmoji } from "@/components/RoleChip";
import type { TeamMember } from "@/lib/teamData";

/**
 * Card for one teammate on `/team`. Server-rendered — every link is a
 * plain `<a>` so the card can ship with zero client-side JS. Reuses
 * the same action-row chrome as UserHoverCard for visual consistency
 * (Gmail compose URL, wa.me link, tel:, calendar event-edit).
 *
 * Three click targets:
 *  - The big upper area (avatar + name + workload chips) is a Link to
 *    /team/[email] — the natural "open profile" gesture.
 *  - The action buttons are individual `<a>` elements with their own
 *    targets; they sit OUTSIDE the upper Link so clicking them never
 *    routes through the profile page first.
 *  - "פרטים מלאים →" footer link is a redundant click target for the
 *    detail page, visible because some users won't realize the upper
 *    area is clickable.
 *
 * The viewer's own email is threaded through so we can append
 * `authuser=<viewer>` to every Google URL — keeps multi-account
 * Chrome users from landing in the wrong profile (see UserHoverCard
 * for the same trick).
 */
export default function TeamPersonCard({
  person,
  viewerEmail,
}: {
  person: TeamMember;
  viewerEmail: string;
}) {
  const displayName = person.heName || person.fullName || person.email;
  const photoUrl = `/api/avatar/${encodeURIComponent(person.email)}`;
  const detailHref = `/team/${encodeURIComponent(person.email)}`;
  const tasksUrl = `/tasks?assignee=${encodeURIComponent(person.email)}`;
  const newTaskUrl = `/tasks/new?assignees=${encodeURIComponent(person.email)}`;

  const authQ = viewerEmail
    ? `&authuser=${encodeURIComponent(viewerEmail)}`
    : "";
  const gmailComposeUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(person.email)}${authQ}`;
  const calendarUrl = `https://calendar.google.com/calendar/u/0/r/eventedit?add=${encodeURIComponent(person.email)}${authQ}`;
  const whatsappUrl = person.mobilePhoneE164
    ? `https://wa.me/${person.mobilePhoneE164}`
    : "";
  const telTarget = person.mobilePhoneE164
    ? `+${person.mobilePhoneE164}`
    : person.mobilePhone || person.workPhone;

  // Heatmap color cue — purely a left-edge accent so a "very busy"
  // teammate is glanceable across the grid. Buckets are deliberately
  // generous because what's "a lot" varies by role (a media buyer
  // managing 30 campaigns vs. a designer with 4 deep tasks).
  const totalActive =
    person.openTasks + person.pendingApproval + person.awaitingClarification;
  const heatLevel =
    totalActive >= 12 ? "hot" : totalActive >= 6 ? "warm" : "cool";

  // Role chip — emoji + raw role text from the sheet (preserves case).
  const role = (person.role || "").trim();
  const emoji = roleEmoji(role);

  return (
    <div
      className="team-card"
      data-heat={heatLevel}
      data-email={person.email}
    >
      <Link href={detailHref} className="team-card-main" prefetch={false}>
        <div className="team-card-head">
          <span className="team-card-avatar" aria-hidden>
            <Image
              src={photoUrl}
              alt=""
              width={48}
              height={48}
              unoptimized
            />
          </span>
          <div className="team-card-id">
            <div className="team-card-name" dir="auto">
              {displayName}
            </div>
            {(person.jobTitle || role) && (
              <div className="team-card-role">
                {person.jobTitle && (
                  <span className="team-card-jobtitle" dir="auto">
                    {person.jobTitle}
                  </span>
                )}
                {person.jobTitle && role && (
                  <span className="team-card-sep" aria-hidden>
                    ·
                  </span>
                )}
                {role && (
                  <span className="team-card-rolepill">
                    {emoji && <span aria-hidden>{emoji}</span>}
                    <span dir="auto">{role}</span>
                  </span>
                )}
              </div>
            )}
            {person.department && person.department !== person.jobTitle && (
              <div className="team-card-dept" dir="auto">
                {person.department}
              </div>
            )}
          </div>
        </div>

        {/* Workload chips. Each one self-hides when its count is 0 so
            cards stay compact for low-load teammates. The "open" chip
            always renders even at 0 because that's the headline number
            — users expect a slot for it. */}
        <div className="team-card-chips" aria-label="עומס עבודה">
          <span
            className={`team-card-chip team-card-chip-open${person.openTasks === 0 ? " is-zero" : ""}`}
            title="משימות פעילות (ממתינות לטיפול + בעבודה)"
          >
            🔥 <b>{person.openTasks}</b> פעילות
          </span>
          {person.pendingApproval > 0 && (
            <span
              className="team-card-chip team-card-chip-approve"
              title="משימות שממתינות לאישור של איש/אשת הצוות"
            >
              ⏳ <b>{person.pendingApproval}</b> ממתינות לאישור
            </span>
          )}
          {person.awaitingClarification > 0 && (
            <span
              className="team-card-chip team-card-chip-stuck"
              title="תקועות בבירור"
            >
              ❓ <b>{person.awaitingClarification}</b> בבירור
            </span>
          )}
          {person.doneThisWeek > 0 && (
            <span
              className="team-card-chip team-card-chip-done"
              title="משימות שסיים/מה השבוע (7 ימים אחרונים)"
            >
              ✅ <b>{person.doneThisWeek}</b> השבוע
            </span>
          )}
        </div>

        {person.topProjects.length > 0 && (
          <div className="team-card-projects" aria-label="פרויקטים מובילים">
            {person.topProjects.slice(0, 3).map((p) => (
              <span key={p} className="team-card-project-chip" dir="auto">
                {p}
              </span>
            ))}
            {person.topProjects.length > 3 && (
              <span className="team-card-project-more">
                +{person.topProjects.length - 3}
              </span>
            )}
          </div>
        )}
      </Link>

      <div className="team-card-actions" role="group" aria-label="פעולות">
        <a
          className="team-card-action"
          href={gmailComposeUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`פתח Gmail עם ${person.email}`}
        >
          <GmailIcon size="16" />
          <span>Gmail</span>
        </a>
        {whatsappUrl && (
          <a
            className="team-card-action team-card-action-whatsapp"
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={`WhatsApp · ${person.mobilePhone}`}
          >
            <WhatsAppIcon size="16" />
            <span>WhatsApp</span>
          </a>
        )}
        {telTarget && (
          <a
            className="team-card-action"
            href={`tel:${telTarget}`}
            title={`חיוג · ${person.mobilePhone || person.workPhone}`}
          >
            <span aria-hidden>📞</span>
            <span>חיוג</span>
          </a>
        )}
        <a
          className="team-card-action"
          href={calendarUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="קבע פגישה ב-Calendar"
        >
          <span aria-hidden>📅</span>
          <span>פגישה</span>
        </a>
        <a className="team-card-action" href={tasksUrl} title="המשימות שלו/ה">
          <span aria-hidden>📋</span>
          <span>משימות</span>
        </a>
        <a className="team-card-action" href={newTaskUrl} title="הקצה משימה">
          <span aria-hidden>➕</span>
          <span>הקצה</span>
        </a>
      </div>

      <Link href={detailHref} className="team-card-more" prefetch={false}>
        פרטים מלאים ←
      </Link>
    </div>
  );
}
