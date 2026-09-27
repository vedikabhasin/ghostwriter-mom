#!/usr/bin/env node
// -----------------------------------------------------------------------------
// scripts/reset-company.mjs <slug> [--dry-run|--confirm] [--force]
//
// Wipes a company's runtime state back to "fresh install":
//   * deletes swipe_events, decisions, approvals, notes, members, articles,
//     hub_items for that company
//   * sets subscription_status='none', hub_unlocked=false, subscription_ends_at=null
//   * keeps the company row and its cards intact
//   * NEVER deletes auth users
//
// Safety:
//   --dry-run   prints the row counts it would delete and changes nothing.
//   --confirm   required for a real run. Without it the script prints a
//               refusal notice.
//   --force     required when the company has is_internal = true (Vedika's
//               personal portal etc.). Without --force internals refuse.
// -----------------------------------------------------------------------------
import { createClient } from "@supabase/supabase-js";

function die(msg, code = 1) { console.error(msg); process.exit(code); }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  die("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.");
}

const args = process.argv.slice(2);
const slug = args.find(a => !a.startsWith("--"));
if (!slug) die("usage: node scripts/reset-company.mjs <slug> [--dry-run|--confirm] [--force]");
const flags = new Set(args.filter(a => a.startsWith("--")));
const isDry     = flags.has("--dry-run");
const isConfirm = flags.has("--confirm");
const isForce   = flags.has("--force");
if (!isDry && !isConfirm) {
  die("refusing to reset without --dry-run or --confirm.", 2);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function loadCompany() {
  const { data, error } = await supabase
    .from("companies")
    .select("id, slug, name, is_internal")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  if (!data)  die(`no company with slug ${slug}`, 3);
  return data;
}

async function count(table, companyId) {
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("company_id", companyId);
  if (error) throw error;
  return count ?? 0;
}

// Order matters: swipe_events + decisions + approvals + articles + hub_items
// + notes reference cards + members and cascade off company_id, but we prune
// child rows first for clarity in the row-count printout. Members last because
// removing them invalidates any `notes.member_id` cascade set-null.
const CHILD_TABLES = [
  "swipe_events",
  "decisions",
  "approvals",
  "articles",
  "hub_items",
  "notes",
  "members",
];

(async () => {
  try {
    const company = await loadCompany();

    if (company.is_internal && !isForce) {
      die(
        `refusing to reset internal company ${slug} (${company.name}) without --force. ` +
        `internal companies are personal — pass --force if you really mean it.`,
        4
      );
    }

    const counts = {};
    for (const t of CHILD_TABLES) counts[t] = await count(t, company.id);
    const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);

    console.log(`– reset target: ${slug} (${company.name}, id ${company.id})`);
    console.log(`– mode: ${isDry ? "DRY RUN" : "LIVE"}${isForce ? " (--force)" : ""}`);
    console.log(`– rows to delete:`);
    for (const t of CHILD_TABLES) console.log(`    ${t.padEnd(14)} ${counts[t]}`);
    console.log(`– total child rows: ${totalRows}`);
    console.log(`– company row + cards will be KEPT.`);
    console.log(`– auth.users will NEVER be touched.`);

    if (isDry) {
      console.log("\ndry run: nothing was deleted.");
      return;
    }

    for (const t of CHILD_TABLES) {
      const { error } = await supabase.from(t).delete().eq("company_id", company.id);
      if (error) throw new Error(`delete ${t}: ${error.message}`);
      console.log(`  ✓ cleared ${t}`);
    }

    const { error: updErr } = await supabase
      .from("companies")
      .update({
        subscription_status:  "none",
        hub_unlocked:         false,
        subscription_ends_at: null,
      })
      .eq("id", company.id);
    if (updErr) throw new Error(`reset company row: ${updErr.message}`);
    console.log("  ✓ company subscription_status=none, hub_unlocked=false, subscription_ends_at=null");

    console.log(`\n✓ reset complete for ${slug}.`);
  } catch (err) {
    console.error("reset failed:", err?.message ?? err);
    process.exit(1);
  }
})();
