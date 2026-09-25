// -----------------------------------------------------------------------------
// invite-member — Deno edge function, called by the portal's Hub invite pop-up.
// Deploy with:  supabase functions deploy invite-member
// (JWT verification ON: the caller must be a signed-in portal member.)
//
// Body: { emails: string[] }   (1 or 2 addresses; `email: string` also works)
//
// Checks, in order:
//   1. caller has a valid session and is a member of a company
//   2. every address is a valid email and is not already on the team
//   3. current members + new invites stays at 3 or under
// Then, per address: inviteUserByEmail (Supabase Auth sends the only email)
// and insert a members row (role 'member', random avatar_shape).
//
// Environment (provided by the Supabase runtime unless noted):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   PORTAL_REDIRECT   optional, defaults to https://www.ghostwriter.mom/portal
// -----------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTAL_REDIRECT  = Deno.env.get("PORTAL_REDIRECT") ?? "https://www.ghostwriter.mom/portal";
const MAX_MEMBERS      = 3;

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

async function inviteOrFind(email: string): Promise<string | null> {
  const invite = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: PORTAL_REDIRECT });
  if (invite.data?.user?.id) return invite.data.user.id;
  // Existing user: they sign in with "Send me a link" on /portal.
  return await findUserId(email);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // 1. Caller.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "not_signed_in" });
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json(401, { error: "not_signed_in" });
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
  const { data: team, error: teamErr } = await admin
    .from("members")
    .select("id, user_id, avatar_shape")
    .eq("company_id", caller.company_id);
  if (teamErr) return json(500, { error: "lookup_failed" });
  if (team.length + emails.length > MAX_MEMBERS) {
    return json(409, { error: "seat_limit", seats_left: Math.max(0, MAX_MEMBERS - team.length) });
  }

  const taken = team.map((m) => m.avatar_shape ?? "");
  const results: { email: string; status: "invited" | "already_member" | "failed" }[] = [];

  for (const email of emails) {
    try {
      const userId = await inviteOrFind(email);
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
      results.push({ email, status: "invited" });
    } catch (err) {
      console.error("invite failed", err instanceof Error ? err.message : err);
      results.push({ email, status: "failed" });
    }
  }

  const ok = results.some((r) => r.status === "invited" || r.status === "already_member");
  return json(ok ? 200 : 502, { results, seats_left: Math.max(0, MAX_MEMBERS - team.length) });
});
