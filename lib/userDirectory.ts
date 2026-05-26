/**
 * Resolve a Workspace user's directory profile (name, title, department,
 * phones) via the Admin SDK Directory API (`users.get`). Mirrors the
 * pattern in `userAvatar.ts`: SA + DWD impersonation of
 * `DRIVE_FOLDER_OWNER`, scope `auth/admin.directory.user.readonly`
 * already granted.
 *
 * Used by `/api/user-card/<email>` to enrich the `<UserHoverCard>` with
 * the kind of info Gmail's contact card shows — most usefully the
 * `mobile` phone, which powers the WhatsApp button.
 *
 * Caching: process-local Map. 24h positive TTL, 1h negative TTL — same
 * shape as the photo cache, so we don't slam the API on hover-heavy
 * pages (tasks list, project rosters).
 */

import { directoryClient, driveFolderOwner } from "@/lib/sa";

const TTL_MS = 24 * 60 * 60 * 1000;
const NEG_TTL_MS = 60 * 60 * 1000;

export type DirectoryUser = {
  email: string;
  fullName: string;
  givenName: string;
  familyName: string;
  /** Workspace "job title" — e.g. "Account Manager". Distinct from the
   *  Hub's role/department concept (which comes from names_to_emails). */
  jobTitle: string;
  /** Workspace department string (the Admin Console field, not our
   *  names_to_emails Role). Sometimes empty. */
  department: string;
  /** Primary mobile phone in E.164-ish form (digits-only with leading
   *  country code; no `+`). Empty when no mobile on profile.
   *  WhatsApp's `wa.me/<digits>` accepts this shape directly. */
  mobilePhoneE164: string;
  /** Original mobile string as entered in Workspace (for display). */
  mobilePhone: string;
  /** Work phone (if set), display-only. */
  workPhone: string;
};

type Cached = {
  user: DirectoryUser | null;
  expiresAt: number;
};

const cache = new Map<string, Cached>();

function isFandfEmail(email: string): boolean {
  return /^[^\s@]+@fandf\.co\.il$/i.test(email.trim());
}

/** Strip everything but digits + a leading `+`. Used to normalize the
 *  user-entered phone strings Workspace stores. */
function digitsOnly(s: string): string {
  return String(s || "").replace(/[^\d]/g, "");
}

/** Israeli default heuristic: a local-format number ("052-...", "025-...")
 *  → prepend "972" and drop the leading 0. Anything that looks already
 *  international (no leading 0, length ≥ 10) is returned digits-only. */
function toIsraeliE164(raw: string): string {
  const d = digitsOnly(raw);
  if (!d) return "";
  if (d.startsWith("972")) return d;
  if (d.startsWith("0")) return "972" + d.slice(1);
  return d;
}

function pickPrimaryByType(
  phones: { value?: string | null; type?: string | null; primary?: boolean | null }[] | undefined | null,
  type: "mobile" | "work",
): string {
  if (!Array.isArray(phones) || phones.length === 0) return "";
  // Prefer explicit primary+matching-type, then any matching-type, then
  // the first one of that type-ish. Workspace lets users free-type the
  // `type` field, so case-insensitive partial match catches "Mobile"
  // and "mobile_phone" and friends.
  const matches = phones.filter((p) =>
    String(p.type || "").toLowerCase().includes(type),
  );
  if (matches.length === 0) return "";
  const primary = matches.find((p) => p.primary);
  return String((primary || matches[0]).value || "").trim();
}

/** Does this phone-number string look like an Israeli mobile? Used as a
 *  fallback when no explicitly Mobile-typed phone is on the Workspace
 *  profile but a "Work"-typed one is actually a mobile number (very
 *  common at F&F — most teammates have their cellphone filed as Work).
 *  Israeli mobile shapes: 10 digits "05X-XXX-XXXX" (local) or 12 digits
 *  "+972 5X-XXX-XXXX" (intl). */
function looksLikeIsraeliMobile(raw: string): boolean {
  const d = digitsOnly(raw);
  if (/^972[5][0-9]{8}$/.test(d)) return true;   // +972-5X-XXXXXXX
  if (/^05[0-9]{8}$/.test(d)) return true;       // 05X-XXXXXXX local
  return false;
}

export async function getDirectoryUser(
  email: string,
): Promise<DirectoryUser | null> {
  const key = email.toLowerCase().trim();
  if (!key || !isFandfEmail(key)) return null;

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  try {
    const directory = directoryClient(driveFolderOwner());
    const res = await directory.users.get({
      userKey: key,
      projection: "full",
    });
    const u = res.data;
    if (!u) {
      cache.set(key, { user: null, expiresAt: Date.now() + NEG_TTL_MS });
      return null;
    }
    const phonesArr = Array.isArray(u.phones) ? u.phones : [];
    const mobileExplicit = pickPrimaryByType(phonesArr, "mobile");
    const workExplicit = pickPrimaryByType(phonesArr, "work");
    // Fallback: if there's no explicit Mobile-typed phone but ANY phone
    // on the profile is shaped like an Israeli mobile (+972 5… / 05…),
    // treat IT as the mobile. Necessary because the F&F team typically
    // files their cellphone under "Work" type.
    let mobileRaw = mobileExplicit;
    if (!mobileRaw) {
      const m = phonesArr.find((p) =>
        looksLikeIsraeliMobile(String((p && p.value) || "")),
      );
      mobileRaw = m ? String((m && m.value) || "").trim() : "";
    }
    // If we "promoted" a work-typed number to mobile (same digits), drop
    // it from the workPhone field so the card doesn't show the same
    // number twice.
    const workRaw =
      workExplicit && digitsOnly(workExplicit) !== digitsOnly(mobileRaw)
        ? workExplicit
        : "";
    const orgs = Array.isArray(u.organizations) ? u.organizations : [];
    const primaryOrg =
      orgs.find((o) => o && o.primary) || orgs[0] || ({} as { title?: string; department?: string });
    const user: DirectoryUser = {
      email: key,
      fullName: String(u.name?.fullName || "").trim(),
      givenName: String(u.name?.givenName || "").trim(),
      familyName: String(u.name?.familyName || "").trim(),
      jobTitle: String(primaryOrg.title || "").trim(),
      department: String(primaryOrg.department || "").trim(),
      mobilePhone: mobileRaw,
      mobilePhoneE164: mobileRaw ? toIsraeliE164(mobileRaw) : "",
      workPhone: workRaw,
    };
    cache.set(key, { user, expiresAt: Date.now() + TTL_MS });
    return user;
  } catch (e) {
    const code =
      (e as { code?: number; response?: { status?: number } }).code ??
      (e as { response?: { status?: number } }).response?.status;
    if (code !== 404) {
      console.log(
        "[userDirectory] users.get failed for",
        email,
        "code=" + code + ":",
        e instanceof Error ? e.message : e,
      );
    }
    cache.set(key, {
      user: null,
      expiresAt: Date.now() + (code === 404 ? TTL_MS : NEG_TTL_MS),
    });
    return null;
  }
}
