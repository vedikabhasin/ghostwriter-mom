// -----------------------------------------------------------------------------
// invite-member: Deno edge function, called by the portal's invite pop-up.
// Deploy with:  supabase functions deploy invite-member --no-verify-jwt
// Platform JWT check is OFF on purpose (supabase/config.toml): the project
// signs sessions with ES256 keys, which the legacy verify_jwt gate rejects.
// The function verifies the caller itself with admin.auth.getUser(token).
//
// Body: { emails: string[] }   (1 or 2 addresses; `email: string` also works)
//
// Checks, in order:
//   1. caller has a valid session and is a member of a company
//   2. every address is a valid email and is not already on the team
//   3. current members + new invites stays within companies.seat_limit (3
//      unless raised, e.g. for a temporary test seat)
// Then, per address: inviteUserByEmail (Supabase Auth sends the only email)
// and insert a members row (role 'member', random avatar_shape). An address
// that already has an account can't be invited, so it gets a normal sign-in
// link instead. Either way exactly one email goes out.
//
// Errors (top-level `error`): not_signed_in, not_a_member, no_email,
// too_many, invalid_email, self_invite, seat_limit, already_member (every
// address is already on the team), failed (502, nothing was sent).
//
// Environment (provided by the Supabase runtime unless noted):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   PORTAL_REDIRECT   optional, defaults to https://www.ghostwriter.mom/portal
// -----------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTAL_REDIRECT  = Deno.env.get("PORTAL_REDIRECT") ?? "https://www.ghostwriter.mom/portal";

// Same six names the Stripe webhook assigns; the portal draws them as monsters.
const AVATAR_SHAPES = ["blob", "worm", "ghost", "spike", "pebble", "curl"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function pickAvatar(taken: string[]): string {
  const free = AVATAR_SHAPES.filter((s) => !taken.includes(s));
  const pool = free.length ? free : AVATAR_SHAPES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function nameFromEmail(email: string): string {
  const local = email.split("@")[0].split(/[._+-]/)[0] || email.split("@")[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// inviteUserByEmail fails for an address that already has an auth user; in
// that case find the existing id (same approach as the Stripe webhook).
async function findUserId(email: string): Promise<string | null> {
  const perPage = 200;
  for (let page = 1; page <= 25; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < perPage) break;
  }
  return null;
}

// Returns the user id and whether the invite email already went out.
async function inviteOrFind(email: string): Promise<{ id: string | null; emailed: boolean }> {
  const invite = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: PORTAL_REDIRECT });
  if (invite.data?.user?.id) return { id: invite.data.user.id, emailed: true };
  if (invite.error) console.error("inviteUserByEmail", invite.error.status, invite.error.message);
  return { id: await findUserId(email), emailed: false };
}

// Existing account: the same sign-in link as "Send me a link" on /portal.
async function sendSignInLink(email: string): Promise<boolean> {
  const { error } = await admin.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: PORTAL_REDIRECT },
  });
  if (error) console.error("signInWithOtp", error.status, error.message);
  return !error;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // 1. Caller.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "not_signed_in" });
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    console.error("getUser failed", userErr?.status, userErr?.message);
    return json(401, { error: "not_signed_in" });
  }
  const callerId = userData.user.id;

  const { data: callerRows, error: callerErr } = await admin
    .from("members")
    .select("id, company_id, created_at")
    .eq("user_id", callerId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (callerErr) return json(500, { error: "lookup_failed" });
  const caller = callerRows?.[0];
  if (!caller) return json(403, { error: "not_a_member" });

  // 2. Input.
  let body: { emails?: unknown; email?: unknown };
  try { body = await req.json(); } catch { return json(400, { error: "bad_json" }); }
  const raw = Array.isArray(body.emails) ? body.emails : body.email ? [body.email] : [];
  const emails = [...new Set(
    raw.map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean),
  )];
  if (!emails.length) return json(400, { error: "no_email" });
  if (emails.length > 2) return json(400, { error: "too_many" });
  const bad = emails.filter((e) => e.length > 254 || !EMAIL_RE.test(e));
  if (bad.length) return json(400, { error: "invalid_email", emails: bad });
  if (userData.user.email && emails.includes(userData.user.email.toLowerCase())) {
    return json(400, { error: "self_invite" });
  }

  // 3. Seats.
  const { data: co, error: coErr } = await admin.from("companies").select("seat_limit").eq("id", caller.company_id).single();
  if (coErr || !co) return json(500, { error: "lookup_failed" });
  const MAX_MEMBERS = co.seat_limit ?? 3;
  const { data: team, error: teamErr } = await admin
    .from("members")
    .select("id, user_id, avatar_shape")
    .eq("company_id", caller.company_id);
  if (teamErr) return json(500, { error: "lookup_failed" });
  if (team.length + emails.length > MAX_MEMBERS) {
    return json(409, { error: "seat_limit", seat_limit: MAX_MEMBERS, seats_left: Math.max(0, MAX_MEMBERS - team.length) });
  }

  const taken = team.map((m) => m.avatar_shape ?? "");
  const results: { email: string; status: "invited" | "already_member" | "added_no_email" | "failed" }[] = [];

  for (const email of emails) {
    try {
      const { id: userId, emailed } = await inviteOrFind(email);
      if (!userId) { results.push({ email, status: "failed" }); continue; }
      if (team.some((m) => m.user_id === userId)) {
        results.push({ email, status: "already_member" });
        continue;
      }
      const avatar = pickAvatar(taken);
      const { error } = await admin.from("members").insert({
        company_id:   caller.company_id,
        user_id:      userId,
        role:         "member",
        display_name: nameFromEmail(email),
        avatar_shape: avatar,
      });
      if (error) {
        // The DB trigger enforces the cap too; a race lands here.
        console.error("members insert failed", error.code, error.message);
        results.push({ email, status: "failed" });
        continue;
      }
      taken.push(avatar);
      team.push({ id: "", user_id: userId, avatar_shape: avatar });
      // The seat is theirs even if the link fails; they can ask for a fresh
      // one on /portal. Report it so the pop-up can say so.
      const sent = emailed || await sendSignInLink(email);
      results.push({ email, status: sent ? "invited" : "added_no_email" });
    } catch (err) {
      console.error("invite failed", err instanceof Error ? err.message : err);
      results.push({ email, status: "failed" });
    }
  }

  const seats_left = Math.max(0, MAX_MEMBERS - team.length);
  if (results.every((r) => r.status === "already_member")) {
    return json(409, { error: "already_member", results, seats_left });
  }
  if (!results.some((r) => r.status === "invited")) {
    return json(502, { error: "failed", results, seats_left });
  }
  return json(200, { results, seats_left });
});
