#!/usr/bin/env node
// -----------------------------------------------------------------------------
// scripts/import-client.mjs
// Usage:  node scripts/import-client.mjs clients/<file>.json
//
// Reads a client JSON in the current shape (see clients/rpr-k7m2qx.json) and
// upserts a company + its cards + latest signal into Supabase via the service
// role key. Idempotent — safe to re-run whenever the JSON changes.
//
// Supports two feed shapes:
//   * Regular client:  needs stripeLink19, offerText, directionShape,
//                      emailKnown. Not is_internal.
//   * Internal:        set isInternal: true on the top-level object. Skips
//                      the sales-page fields (stripeLink19 / offerText /
//                      directionShape / emailKnown are optional). Company row
//                      is written with is_internal = true so spots_left()
//                      keeps counting real clients only.
//
// Cards optionally carry a "series" string (e.g. "VB", "BlendXR"). It lands in
// the cards.series column and is rendered as a small ink-outline label on the
// sales page + portal. Cards may also carry "formatNote" (cards.format_note,
// stored only, never rendered).
//
// Formats: pillar / insight / post (RPR) plus long_form / short_insight /
// linkedin_post (leads). The list lives in /shared/formats.js; the DB check
// constraints match it (migration 20260930000014_lead_formats).
//
// Lead fields on the top-level object, both optional:
//   greetingName  string or null -> companies.greeting_name ("Hi there." when null)
//   introBasis    string or null -> companies.intro_basis  (RPR sentence when null)
// signal may be null: nothing is written to signals (existing rows are left).
//
// Env:
//   SUPABASE_URL                the project URL (https://xxx.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY   service role key (server-side only)
// -----------------------------------------------------------------------------
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

function die(msg) { console.error(msg); process.exit(1); }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  die("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.");
}

const [, , fileArg] = process.argv;
if (!fileArg) die("usage: node scripts/import-client.mjs clients/<file>.json");

const filePath = path.resolve(process.cwd(), fileArg);
if (!fs.existsSync(filePath)) die(`file not found: ${filePath}`);

const raw = fs.readFileSync(filePath, "utf8");
let data;
try { data = JSON.parse(raw); } catch (err) { die(`invalid JSON: ${err.message}`); }

// swipe2 configs (templates/README.md) name three fields differently.
if (data.template === "swipe2") {
  data.companyName  = data.companyName  ?? data.company;
  data.introBasis   = data.introBasis   ?? data.sourceLine;
  data.greetingName = data.greetingName ?? data.contactFirstName;
}

const {
  slug, companyName, contactFirstName, emailKnown,
  directionShape, offerText, signal, cards,
  isInternal, greetingName, introBasis
} = data;

const FORMATS = createRequire(import.meta.url)("../shared/formats.js").list;
cards?.forEach?.((c, i) => {
  if (!FORMATS.includes(String(c.format))) {
    die(`card #${i + 1} (${c.id}) has unknown format "${c.format}"; allowed: ${FORMATS.join(", ")}`);
  }
});

if (!slug)        die("client JSON missing 'slug'");
if (!companyName) die("client JSON missing 'companyName'");
if (!Array.isArray(cards) || !cards.length) die("client JSON missing non-empty 'cards'");

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function upsertCompany() {
  // Internal companies don't need sales-page fields, so we don't null-out
  // what's already set — just pass what's present.
  const payload = {
    slug,
    name: companyName,
    contact_first_name: contactFirstName ?? null,
    is_internal: isInternal === true,
  };
  if (typeof emailKnown === "boolean")    payload.email_known    = emailKnown;
  if (directionShape !== undefined)       payload.direction_shape = directionShape ?? {};
  if (offerText !== undefined)            payload.offer_text     = offerText ?? null;
  if (greetingName !== undefined)         payload.greeting_name  = greetingName ?? null;
  if (introBasis !== undefined)           payload.intro_basis    = introBasis ?? null;

  const { data: existing, error: selErr } = await supabase
    .from("companies").select("id").eq("slug", slug).maybeSingle();
  if (selErr) throw selErr;
  if (existing) {
    const { error } = await supabase.from("companies").update(payload).eq("id", existing.id);
    if (error) throw error;
    return existing.id;
  }
  // Insert path: internal companies default to direction_shape {} and
  // email_known false if the JSON leaves them out.
  const insertPayload = {
    ...payload,
    direction_shape: payload.direction_shape ?? {},
    email_known:     payload.email_known ?? false,
  };
  const { data: inserted, error } = await supabase
    .from("companies").insert(insertPayload).select("id").single();
  if (error) throw error;
  return inserted.id;
}

async function upsertCards(companyId) {
  let order = 0;
  const rows = cards.map(c => ({
    company_id: companyId,
    card_key:   c.id,
    format:     c.format,
    title:      c.title,
    angle:      c.angle,
    evidence:   c.evidence,
    tags:       Array.isArray(c.tags) ? c.tags : [],
    sources:    c.sources ?? [],
    series:     c.series ?? null,
    format_note: c.formatNote ?? null,
    sort_order: order++,
  }));
  const { error } = await supabase
    .from("cards")
    .upsert(rows, { onConflict: "company_id,card_key" });
  if (error) throw error;

  // Belt-and-suspenders: delete any card rows for this company whose card_key
  // is NOT in the current JSON. Keeps the DB in sync when a key is removed.
  const keptKeys = rows.map(r => r.card_key);
  const { error: pruneErr } = await supabase
    .from("cards")
    .delete()
    .eq("company_id", companyId)
    .not("card_key", "in", `(${keptKeys.map(k => `"${k.replace(/"/g, '""')}"`).join(",")})`);
  if (pruneErr) throw pruneErr;

  return rows.length;
}

async function upsertSignal(companyId) {
  if (!signal) return 0;
  // Signal is treated as a single "latest" row per company here (JSON is the
  // canonical source). Portal-side signal history is a Session B concern.
  const { error: delErr } = await supabase
    .from("signals").delete().eq("company_id", companyId);
  if (delErr) throw delErr;
  const { error } = await supabase.from("signals").insert({
    company_id: companyId,
    text:       signal.text,
    source:     signal.source,
    signal_date: signal.date,
  });
  if (error) throw error;
  return 1;
}

(async () => {
  try {
    const companyId = await upsertCompany();
    const cardCount = await upsertCards(companyId);
    const sigCount  = await upsertSignal(companyId);
    console.log(
      `✓ imported ${slug} — company ${companyId}` +
      (isInternal ? " (INTERNAL)" : "") +
      `, ${cardCount} cards, ${sigCount} signal(s)`
    );
  } catch (err) {
    console.error("import failed:", err?.message ?? err);
    process.exit(1);
  }
})();
