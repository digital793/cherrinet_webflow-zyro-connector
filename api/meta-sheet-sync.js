// api/meta-sheet-sync.js
//
// Polls the Google Sheet Meta Lead Ads auto-populates (native "Google
// Sheets" lead sync — no Meta Developer App / webhook needed) and creates
// a Zyro lead for every row we haven't processed yet.
//
// NOTE: this endpoint is triggered by an event-driven Apps Script
// (onChange) living inside the Google Sheet itself, not by a fixed
// schedule. See meta-sync-trigger.gs. Still safe to call manually any
// time, since it tracks which lead `id`s it has already synced (via
// Supabase Postgres) and skips them on every re-run.
//
// DB USAGE — switched from Upstash Redis (Vercel KV) to Supabase
// Postgres. Same efficiency pattern as before: we load the FULL set of
// already-synced lead ids in ONE query at the top of the run, and write
// all newly-synced ids in ONE batch insert at the end — never one query
// per row. Do not reintroduce a per-row DB call here.
//
// SHEET COLUMNS (confirmed from the live sheet "Cherriner Pincode CRM
// setup" on 2026-07-31):
//   id, created_time, ad_id, ad_name, adset_id, adset_name, campaign_id,
//   campaign_name, form_id, form_name, is_organic, platform,
//   which_plan_are_you_interested_in?, email_address, phone_number,
//   first_name, zip_code, lead_status
//
//   NOTE: zip_code is a new column added between first_name and
//   lead_status. Like phone_number (prefixed "p:"), Meta prefixes it with
//   "z:" (e.g. "z:638008") — stripped by normalizeZip() below.
//
// SETUP NEEDED:
//   1. In Supabase SQL Editor, run:
//        create table synced_leads (
//          lead_id text primary key,
//          synced_at timestamp default now()
//        );
//   2. `npm install @supabase/supabase-js` in your project.
//   3. Env vars (already added to Vercel via the Supabase integration):
//        NEXT_PUBLIC_SUPABASE_URL
//        SUPABASE_SERVICE_ROLE_KEY   <-- required, NOT the anon key.
//          The service role key is needed because this runs server-side
//          and must bypass Row Level Security to read/write the
//          synced_leads table. Never expose this key to the browser —
//          it's only used here, inside a serverless function.
//   4. Env var GOOGLE_SHEET_CSV_URL — the export URL below, built from
//      your sheet's ID (already filled in from the link you shared).
//   5. Sync is triggered by meta-sync-trigger.gs (installed inside the
//      Google Sheet via Extensions > Apps Script) — see that file.

import { createClient } from '@supabase/supabase-js';
import Papa from 'papaparse';

const SHEET_ID = '1llrl-ZjcjuFn6cCtPv0Q_N9V233s_SFgFiHw8OobePg';
const CSV_URL = process.env.GOOGLE_SHEET_CSV_URL
  || `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

export default async function handler(req, res) {
  // Allow both GET (manual browser trigger / Apps Script call) and POST.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const ZYRO_BASE = process.env.ZYRO_BASE_URL;
  const API_KEY   = process.env.ZYRO_API_KEY;
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!ZYRO_BASE || !API_KEY) {
    console.error('Missing ZYRO_BASE_URL or ZYRO_API_KEY environment variable');
    return res.status(500).json({ error: 'server_misconfigured' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ---- Step 1: fetch + parse the sheet ----
  const csvRes = await fetch(CSV_URL);
  if (!csvRes.ok) {
    console.error('Failed to fetch Google Sheet CSV:', csvRes.status);
    return res.status(502).json({ error: 'sheet_fetch_failed' });
  }
  const csvText = await csvRes.text();

  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  const rows = parsed.data;

  console.log(`META SHEET SYNC: fetched ${rows.length} row(s)`);

  // ---- Step 2: load the FULL synced-leads set in ONE query ----
  // (Replaces the old Redis kv.smembers call.)
  const { data: syncedRows, error: readErr } = await supabase
    .from('synced_leads')
    .select('lead_id');

  if (readErr) {
    console.error('META SHEET SYNC: failed to read synced_leads from Supabase', readErr);
    return res.status(502).json({ error: 'db_read_failed' });
  }

  const syncedSet = new Set((syncedRows || []).map(r => r.lead_id));

  // Collect ids that need to be added to the synced set. We batch these
  // into a single insert at the end instead of one write per lead.
  const newlySyncedIds = [];

  let created = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    const leadId = row['id'];
    if (!leadId) continue; // blank row

    // ---- Step 3: skip if we've already synced this lead (in-memory check) ----
    if (syncedSet.has(leadId)) {
      skipped++;
      continue;
    }

    // ---- Step 4: map row → Zyro lead payload ----
    const phone = normalizePhone(row['phone_number']);
    if (!phone) {
      console.warn('META SHEET SYNC: row has no usable phone, skipping', JSON.stringify(row));
      newlySyncedIds.push(leadId); // don't retry a bad row forever
      skipped++;
      continue;
    }

    const name = row['first_name'] || 'Meta Lead Ad enquiry';
    const email = row['email_address'];
    const plan = row['which_plan_are_you_interested_in?'];
    const zip = normalizeZip(row['zip_code']);

    const notes = [
      '*** META LEAD AD (via Google Sheet sync) ***',
      `Plan interest: ${plan || ''}`,
      `Zip code: ${zip || ''}`,
      '',
      '--- Full row ---',
      Object.entries(row).map(([k, v]) => `${k}: ${v}`).join('\n')
    ].join('\n');

    try {
      const leadRes = await fetch(`${ZYRO_BASE}/api/v2/webhooks/leads`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name,
          phone,
          email: email && email !== 'test@meta.com' ? email : undefined,
          pincode: zip || undefined, // Zyro's leads schema expects "pincode", not "zip_code" —
                                      // confirmed against create-lead.js / webflow-intake.js,
                                      // which both use "pincode" successfully. Sending
                                      // "zip_code" was a field-name mismatch Zyro silently
                                      // ignored, which is why the Pincode field stayed blank
                                      // on synced leads even though notes had the right value.
          source: 'website',
          campaign: 'meta_lead_ads_sheet',
          notes
        })
      });

      const lead = await leadRes.json();
      console.log('META SHEET SYNC: lead create', leadId, leadRes.status, JSON.stringify(lead));

      if (leadRes.status === 201) {
        newlySyncedIds.push(leadId);
        created++;
      } else {
        // Don't mark as processed — we'll retry it next sync.
        console.error('META SHEET SYNC: create failed for', leadId, leadRes.status, JSON.stringify(lead));
        failed++;
      }
    } catch (err) {
      console.error('META SHEET SYNC: error creating lead for', leadId, err);
      failed++;
    }
  }

  // ---- Step 5: persist all newly-synced ids in ONE batch insert ----
  if (newlySyncedIds.length > 0) {
    const { error: writeErr } = await supabase
      .from('synced_leads')
      .insert(newlySyncedIds.map(id => ({ lead_id: id })));

    if (writeErr) {
      // If this fails, these leads may be re-attempted next run. Safe
      // for the "bad row" skips; for real creates, this should be rare
      // since it's a single batched request.
      console.error('META SHEET SYNC: failed to persist synced ids to Supabase', writeErr);
    }
  }

  console.log(`META SHEET SYNC done: ${created} created, ${skipped} skipped, ${failed} failed`);
  return res.status(200).json({ ok: true, created, skipped, failed, totalRows: rows.length });
}

// Meta's sheet usually prefixes phone values with "p:+91..." (visible in
// most rows), but we've seen at least one row come through as bare digits
// with neither the "p:" prefix nor the "+" (e.g. "8428068041" or
// "918428068041" instead of "p:+918428068041") — so this normalizes to a
// consistent "+91XXXXXXXXXX" output regardless of what the source row
// actually contains, instead of just stripping "p:" and hoping the rest
// is already well-formed.
function normalizePhone(raw) {
  if (!raw) return null;
  let cleaned = raw.replace(/^p:/, '').trim();
  if (!cleaned || cleaned.startsWith('<test lead')) return null; // Meta's dummy test row

  // Strip everything except digits and a leading +, so we can reason
  // about the digit count regardless of stray spaces/dashes.
  const digitsOnly = cleaned.replace(/[^\d+]/g, '');

  if (digitsOnly.startsWith('+')) {
    return digitsOnly; // already has a country code — trust it
  }
  if (digitsOnly.length === 10) {
    return '+91' + digitsOnly; // bare 10-digit Indian mobile number
  }
  if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) {
    return '+' + digitsOnly; // has "91" country code but no "+"
  }

  // Anything else is a shape we haven't seen before — log it and pass
  // through as-is rather than silently mangling it further.
  console.warn('META SHEET SYNC: unrecognized phone format, passing through as-is:', raw);
  return digitsOnly || cleaned;
}

// Same deal as phone: Meta prefixes zip_code values with "z:" (visible in
// the test row, e.g. "z:638008"). Strip that and ignore the dummy test row.
function normalizeZip(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/^z:/, '').trim();
  if (!cleaned || cleaned.startsWith('<test lead')) return null; // Meta's dummy test row
  return cleaned;
}
