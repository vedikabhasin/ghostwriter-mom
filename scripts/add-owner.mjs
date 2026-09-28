#!/usr/bin/env node
// -----------------------------------------------------------------------------
// scripts/add-owner.mjs <slug> <email> [--name "Full Name"] [--days 30]
//                                       [--force] [--extend]
//
// Give a real client a portal without a Stripe checkout: create the auth user
// if needed, insert an owner members row, extend companies.portal_access_until
// by --days (default 30), and CLAIM every anonymous sales-page swipe the
// company has accumulated to that member. One email goes out (invite for a
// brand-new address, magic sign-in link for an address that already has an
// account) — the same behavior as invite-member.
//
// Modes:
//   default   Adds the first owner. Errors if a members row already exists
//             for this company unless --force is passed. --force gives a
//             second owner the seat (useful when handing off to a co-founder).
//   --extend  Skip everything except extending portal_access_until. Used to
//             renew access; refuses if there's no existing owner.
//
// Refuses to run on companies where is_internal = true (those already have a
// permanent portal). Never touches other companies' auth users, even the
// email is only used to LOOK UP the auth user; deletion is out of scope.
//
// Env:
//   SUPABASE_URL                  the project URL
//   SUPABASE_SERVICE_ROLE_KEY     service role key (server-side only)
//   PORTAL_REDIRECT               optional, defaults to the production /portal
// -----------------------------------------------------------------------------
import { createClient } from "@supabase/supabase-js";

function die(msg, code = 1) { console.error(msg); process.exit(code); }

// Argument parsing. Two positional, plus optional flags.
const argv = process.argv.slice(2);
if (argv.length < 2 || argv.includes("--help") || argv.includes("-h")) {
  die(
    "usage: add-owner.mjs <slug> <email> [--name \"Full Name\"] [--days 30] [--force] [--extend]",
    64,
  );
}
const [slug, rawEmail] = argv;
const email = String(rawEmail || "").trim().toLowerCase();
if (!slug || !email) die("both <slug> and <email> are required");
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) die(`invalid email: ${rawEmail}`);

function flagValue(name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) die(`flag ${name} needs a value`);
  return v;
}
const wantForce  = argv.includes("--force");
const wantExtend = argv.includes("--extend");
const displayName = flagValue("--name") ?? null;
const daysRaw = flagValue("--days");
const days = daysRaw ? Number.parseInt(daysRaw, 10) : 30;
if (!Number.isFinite(days) || days <= 0 || days > 365) die("--days must be a positive integer 1..365");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORTAL_REDIRECT = process.env.PORTAL_REDIRECT ?? "https://www.ghostwriter.mom/portal";
if (!SUPABASE_URL || !SERVICE_KEY) die("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment");

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const AVATAR_SHAPES = ["blob","worm","ghost","spike","pebble","curl"];
function pickAvatar(taken) {
  const free = AVATAR_SHAPES.filter(s => !taken.includes(s));
  const pool = free.length ? free : AVATAR_SHAPES;
  return pool[Math.floor(Math.random() * pool.length)];
}
function nameFromEmail(e) {
  const local = e.split("@")[0].split(/[._+-]/)[0] || e.split("@")[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}
function fmtDate(d) {
  const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${m[d.getMonth()]} ${d.getDate()}`;
}

async function findAuthUserId(e) {
  const perPage = 200;
  for (let page = 1; page <= 25; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const hit = data.users.find(u => (u.email ?? "").toLowerCase() === e);
    if (hit) return hit.id;
    if (data.users.length < perPage) break;
  }
  return null;
}

async function claimAnonSwipes(companyId, memberId) {
  // Every swipe_events row with member_id NULL becomes this member's history.
  // For decisions: if the member already has a row for the same card (rare —
  // an add-owner script should run before the owner starts swiping), the anon
  // row is deleted; otherwise it's claimed.
  const { data: eventsUpdated, error: evErr } = await admin
    .from("swipe_events")
    .update({ member_id: memberId })
    .eq("company_id", companyId).is("member_id", null)
    .select("id");
  if (evErr) throw evErr;
  const eventsCount = (eventsUpdated ?? []).length;

  // Anon decisions. Order matters: read the anon rows, then per-row decide
  // whether the member already has a decision for that card.
  const { data: anonDecisions, error: anonErr } = await admin
    .from("decisions").select("id, card_id, action, updated_at")
    .eq("company_id", companyId).is("member_id", null);
  if (anonErr) throw anonErr;

  let claimed = 0;
  let collapsed = 0;
  for (const row of anonDecisions ?? []) {
    const { data: existing } = await admin
      .from("decisions").select("id, updated_at")
      .eq("company_id", companyId).eq("card_id", row.card_id).eq("member_id", memberId)
      .maybeSingle();
    if (existing) {
      // Most-recent-wins on the collision: keep whichever action is newest.
      if (new Date(row.updated_at) > new Date(existing.updated_at)) {
        await admin.from("decisions").update({ action: row.action, updated_at: row.updated_at }).eq("id", existing.id);
      }
      await admin.from("decisions").delete().eq("id", row.id);
      collapsed++;
    } else {
      await admin.from("decisions").update({ member_id: memberId }).eq("id", row.id);
      claimed++;
    }
  }
  return { events: eventsCount, decisions_claimed: claimed, decisions_collapsed: collapsed };
}

(async function main() {
  // Company.
  const { data: company, error: coErr } = await admin
    .from("companies")
    .select("id, name, is_internal, unlock_mode, portal_access_until, seat_limit")
    .eq("slug", slug).maybeSingle();
  if (coErr) throw coErr;
  if (!company) die(`unknown slug: ${slug}`);
  if (company.is_internal) die(`refusing: ${slug} is an internal company (portal is already permanent)`);

  // Existing team.
  const { data: team, error: teamErr } = await admin
    .from("members").select("id, user_id, role, display_name, avatar_shape, created_at")
    .eq("company_id", company.id).order("created_at", { ascending: true });
  if (teamErr) throw teamErr;

  // Extend-only path.
  if (wantExtend) {
    if (!team?.length) die(`--extend refused: ${slug} has no members yet, run without --extend to add the first owner`);
    const base = company.portal_access_until && new Date(company.portal_access_until) > new Date()
      ? new Date(company.portal_access_until)
      : new Date();
    const until = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    const { error } = await admin.from("companies").update({ portal_access_until: until.toISOString() }).eq("id", company.id);
    if (error) throw error;
    console.log(`Portal extended for ${company.name} until ${fmtDate(until)}.`);
    return;
  }

  // Add-owner path. Refuse when an owner already exists unless --force.
  const owners = (team ?? []).filter(m => m.role === "owner");
  if (owners.length && !wantForce) {
    const known = owners.map(o => o.user_id).join(",");
    die(`refusing: ${slug} already has an owner (user_id ${known}). Pass --force to add another.`);
  }

  const seatLimit = company.seat_limit ?? 3;
  if ((team?.length ?? 0) >= seatLimit) die(`refusing: ${slug} is at its seat_limit (${seatLimit}).`);

  // Auth user: create if new; otherwise reuse. NEVER delete or modify others.
  let userId = await findAuthUserId(email);
  let created = false;
  if (!userId) {
    const { data: cu, error: cuErr } = await admin.auth.admin.createUser({
      email, email_confirm: true,
    });
    if (cuErr) die(`failed to create auth user: ${cuErr.message}`);
    userId = cu.user.id;
    created = true;
  }

  // Members row.
  const taken = (team ?? []).map(m => m.avatar_shape ?? "");
  const avatar = pickAvatar(taken);
  const { error: memErr } = await admin.from("members").insert({
    company_id:   company.id,
    user_id:      userId,
    role:         "owner",
    display_name: displayName || nameFromEmail(email),
    avatar_shape: avatar,
  });
  if (memErr) {
    if (memErr.code === "23505") die(`refusing: ${email} is already a member of ${slug}`);
    die(`members insert failed: ${memErr.code ?? ""} ${memErr.message}`);
  }
  const { data: memberRow } = await admin.from("members").select("id").eq("company_id", company.id).eq("user_id", userId).single();

  // portal_access_until: max(existing, now + days).
  const base = company.portal_access_until && new Date(company.portal_access_until) > new Date()
    ? new Date(company.portal_access_until)
    : new Date();
  const until = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  const { error: coUpErr } = await admin.from("companies").update({ portal_access_until: until.toISOString() }).eq("id", company.id);
  if (coUpErr) throw coUpErr;

  // Claim anon swipes for this new member.
  let claim = { events: 0, decisions_claimed: 0, decisions_collapsed: 0 };
  try { claim = await claimAnonSwipes(company.id, memberRow.id); }
  catch (e) { console.error(`WARN: swipe-claim failed: ${e.message ?? e}`); }

  // Send exactly one email: invite for a brand-new account, magic link for an
  // existing one. The runtime (Resend in prod) delivers it.
  let sent = false;
  if (created) {
    // A createUser call above already made the user; inviteUserByEmail would
    // fail. Send a magic link instead (same UX).
    const { error } = await admin.auth.signInWithOtp({
      email, options: { shouldCreateUser: false, emailRedirectTo: PORTAL_REDIRECT },
    });
    sent = !error;
    if (error) console.error(`WARN: sign-in link failed: ${error.message}`);
  } else {
    const { error } = await admin.auth.signInWithOtp({
      email, options: { shouldCreateUser: false, emailRedirectTo: PORTAL_REDIRECT },
    });
    sent = !error;
    if (error) console.error(`WARN: sign-in link failed: ${error.message}`);
  }

  const swipeSummary = `${claim.events} swipe events + ${claim.decisions_claimed} decisions claimed` +
    (claim.decisions_collapsed ? ` (${claim.decisions_collapsed} collapsed on collision)` : "");
  console.log(
    `Portal open for ${company.name} until ${fmtDate(until)}. ` +
    `Owner ${email} added${created ? " (new auth user)" : ""}. ` +
    `${swipeSummary}. ` +
    `${sent ? "Sign-in email sent." : "Sign-in email FAILED — resend from /portal."}`
  );
})().catch(e => die(e?.message ?? String(e), 2));
