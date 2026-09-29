#!/usr/bin/env node
// -----------------------------------------------------------------------------
// scripts/reset-company.mjs <slug> [--dry-run|--confirm] [--force] [options]
//
// Puts a company's runtime state back to "fresh". Cards and the signal row
// are always kept. auth.users are NEVER deleted. The credit ledger and pieces
// are never deleted either (they are money records); their counts are shown.
//
// Modes (pick by flags; nothing here keys on a slug or a person):
//
//   (default) full reset
//     deletes notes, decisions, swipe_events, approvals, articles, hub_items
//     and members; the company row goes back to a prospect:
//       subscription_status='none', subscription_ends_at=null,
//       portal_access_until=null, hub_unlocked=false, unlock_mode='call',
//       first_opened_at=null, seat_limit=3
//
//   --keep-members
//     keeps every members row and resets each one's onboarding to {} (the
//     first-visit tour plays again). Deletes the same activity as a full
//     reset. Implies --keep-company.
//   --keep-hub-text "<prefix>"   (repeatable)
//     keeps hub_items of kind text whose body starts with that prefix, e.g.
//     the rules notes a provisioning script seeded. Every other hub item goes.
//   --keep-company
//     leaves the companies row exactly as it is.
//
//   --member <email>
//     removes one test member only: its members row, its swipe_events and
//     decisions, the anonymous sales-page swipes (member_id null, the ones
//     add-owner claims), the company's approvals, the articles those
//     approvals created, and any notes or hub items the member made. Resets
//     portal_access_until to null (add-owner set it). Cards stay.
//
// Safety:
//   --dry-run   prints what it would delete or change, changes nothing.
//   --confirm   required for a real run.
//   --force     required when the company has is_internal = true.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server-side only).
// -----------------------------------------------------------------------------
import { createClient } from "@supabase/supabase-js";

export const FULL_TABLES = ["swipe_events", "decisions", "approvals", "articles", "hub_items", "notes", "members"];
export const COMPANY_FRESH = {
  subscription_status: "none", subscription_ends_at: null, portal_access_until: null,
  hub_unlocked: false, unlock_mode: "call", first_opened_at: null, seat_limit: 3,
};
const KEPT_ALWAYS = ["cards", "signals", "credit_ledger", "pieces"];

export function parseArgs(argv) {
  const out = { slug: null, dry: false, confirm: false, force: false, keepMembers: false, keepCompany: false, keepText: [], member: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dry = true;
    else if (a === "--confirm") out.confirm = true;
    else if (a === "--force") out.force = true;
    else if (a === "--keep-members") { out.keepMembers = true; out.keepCompany = true; }
    else if (a === "--keep-company") out.keepCompany = true;
    else if (a === "--keep-hub-text") { const v = argv[++i]; if (!v || v.startsWith("--")) throw new Error("--keep-hub-text needs a value"); out.keepText.push(v); }
    else if (a === "--member") { const v = argv[++i]; if (!v || v.startsWith("--")) throw new Error("--member needs an email"); out.member = v.trim().toLowerCase(); }
    else if (a.startsWith("--")) throw new Error("unknown flag " + a);
    else if (!out.slug) out.slug = a;
    else throw new Error("unexpected argument " + a);
  }
  if (!out.slug) throw new Error("usage: node scripts/reset-company.mjs <slug> [--dry-run|--confirm] [--force] [--keep-members] [--keep-hub-text <prefix>] [--keep-company] [--member <email>]");
  if (out.dry === out.confirm) throw new Error("pass exactly one of --dry-run or --confirm.");
  if (out.member && (out.keepMembers || out.keepText.length)) throw new Error("--member can't be combined with --keep-members or --keep-hub-text.");
  return out;
}

const ids = (rows) => rows.map((r) => r.id);
async function rows(sb, table, cols, filters) {
  let q = sb.from(table).select(cols);
  for (const [op, col, val] of filters) q = q[op](col, val);
  const { data, error } = await q;
  if (error) throw new Error(`read ${table}: ${error.message}`);
  return data || [];
}

/** What a run would do: { deletes: {table: [ids]}, kept: {table: n}, company, members } */
export async function planReset(sb, company, opts) {
  const cid = company.id;
  const plan = { deletes: {}, kept: {}, company: null, onboarding: [], notes: [] };
  const by = (col) => [["eq", "company_id", cid]];
  for (const t of KEPT_ALWAYS) plan.kept[t] = (await rows(sb, t, "id", by())).length;

  if (opts.member) {
    const members = await rows(sb, "members", "id, user_id, role, created_at", by());
    const users = await Promise.all(members.map(async (m) => {
      const { data, error } = await sb.auth.admin.getUserById(m.user_id);
      if (error) throw new Error(`look up member user: ${error.message}`);
      return { m, email: String(data?.user?.email || "").toLowerCase() };
    }));
    const hit = users.find((u) => u.email === opts.member);
    if (!hit) throw new Error(`no member ${opts.member} on ${company.slug}`);
    const mid = hit.m.id;
    const swipes = await rows(sb, "swipe_events", "id, member_id", by());
    const decisions = await rows(sb, "decisions", "id, member_id", by());
    const approvals = await rows(sb, "approvals", "id, free_article_card_id", by());
    const freeCards = new Set(approvals.map((a) => a.free_article_card_id).filter(Boolean));
    const articles = await rows(sb, "articles", "id, card_id, requested_by", by());
    const notes = await rows(sb, "notes", "id, member_id", by());
    const hub = await rows(sb, "hub_items", "id, created_by", by());
    plan.deletes = {
      swipe_events: ids(swipes.filter((r) => r.member_id === mid || r.member_id === null)),
      decisions: ids(decisions.filter((r) => r.member_id === mid || r.member_id === null)),
      approvals: ids(approvals),
      articles: ids(articles.filter((a) => a.requested_by === mid || freeCards.has(a.card_id))),
      hub_items: ids(hub.filter((h) => h.created_by === mid)),
      notes: ids(notes.filter((n) => n.member_id === mid)),
      members: [mid],
    };
    plan.kept.members = members.length - 1;
    plan.company = opts.keepCompany ? null : { portal_access_until: null };
    return plan;
  }

  for (const t of FULL_TABLES) {
    if (t === "members" && opts.keepMembers) continue;
    if (t === "hub_items" && opts.keepText.length) {
      const hub = await rows(sb, "hub_items", "id, kind, body", by());
      const keep = hub.filter((h) => h.kind === "text" && opts.keepText.some((p) => String(h.body || "").startsWith(p)));
      plan.deletes.hub_items = ids(hub.filter((h) => !keep.includes(h)));
      plan.kept.hub_items = keep.length;
      plan.kept.hub_text = keep.map((h) => String(h.body).slice(0, 48));
      continue;
    }
    plan.deletes[t] = ids(await rows(sb, t, "id", by()));
  }
  if (opts.keepMembers) {
    const members = await rows(sb, "members", "id, onboarding", by());
    plan.kept.members = members.length;
    plan.onboarding = ids(members);
  }
  plan.company = opts.keepCompany ? null : { ...COMPANY_FRESH };
  return plan;
}

export async function applyReset(sb, company, plan, log = console.log) {
  // Children first; members last (notes and swipes point at them).
  for (const t of FULL_TABLES) {
    const list = plan.deletes[t];
    if (!list || !list.length) continue;
    for (let i = 0; i < list.length; i += 200) {
      const { error } = await sb.from(t).delete().in("id", list.slice(i, i + 200));
      if (error) throw new Error(`delete ${t}: ${error.message}`);
    }
    log(`  cleared ${t}: ${list.length}`);
  }
  if (plan.onboarding.length) {
    const { error } = await sb.from("members").update({ onboarding: {} }).in("id", plan.onboarding);
    if (error) throw new Error(`reset onboarding: ${error.message}`);
    log(`  onboarding reset to {} for ${plan.onboarding.length} members`);
  }
  if (plan.company) {
    const { error } = await sb.from("companies").update(plan.company).eq("id", company.id);
    if (error) throw new Error(`reset company row: ${error.message}`);
    log("  company row: " + JSON.stringify(plan.company));
  }
}

export function printPlan(company, opts, plan, log = console.log) {
  log(`reset target: ${company.slug} (${company.name}, id ${company.id})${company.is_internal ? " [internal]" : ""}`);
  log(`mode: ${opts.dry ? "DRY RUN" : "LIVE"}${opts.force ? " (--force)" : ""}${opts.member ? " (--member " + opts.member + ")" : ""}`);
  log("rows to delete:");
  for (const t of FULL_TABLES) if (plan.deletes[t]) log(`    ${t.padEnd(14)} ${plan.deletes[t].length}`);
  log("kept:");
  for (const [t, n] of Object.entries(plan.kept)) if (t !== "hub_text") log(`    ${t.padEnd(14)} ${n}`);
  if (plan.kept.hub_text) plan.kept.hub_text.forEach((b) => log(`      text: "${b}${b.length === 48 ? "…" : ""}"`));
  if (plan.onboarding.length) log(`members.onboarding -> {} for ${plan.onboarding.length} members`);
  log(plan.company ? "company row -> " + JSON.stringify(plan.company) : "company row: unchanged");
  log("auth.users: never touched.");
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."); process.exit(1); }
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: company, error } = await sb.from("companies").select("id, slug, name, is_internal").eq("slug", opts.slug).maybeSingle();
  if (error) { console.error(error.message); process.exit(1); }
  if (!company) { console.error(`no company with slug ${opts.slug}`); process.exit(3); }
  if (company.is_internal && !opts.force) {
    console.error(`refusing to reset internal company ${opts.slug} without --force.`);
    process.exit(4);
  }
  const plan = await planReset(sb, company, opts);
  printPlan(company, opts, plan);
  if (opts.dry) { console.log("\ndry run: nothing was changed."); return; }
  await applyReset(sb, company, plan);
  console.log(`\nreset complete for ${opts.slug}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error("reset failed:", err?.message ?? err); process.exit(1); });
}
