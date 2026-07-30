// api/meta-sheet-sync.js
//
// Polls the Google Sheet Meta Lead Ads auto-populates (native "Google
// Sheets" lead sync — no Meta Developer App / webhook needed) and creates
// a Zyro lead for every row we haven't processed yet.
//
// WHY POLLING INSTEAD OF A WEBHOOK: a spreadsheet can't push notifications
// to us — we have to periodically re-check it. This function is designed
// to be called on a schedule (Vercel Cron) AND to be safe to call manually
// as often as you like for testing, since it tracks which lead `id`s it
// has already synced (via Vercel KV) and skips them on every re-run.
//
// SHEET COLUMNS (confirmed from the live sheet on 2026-07-30):
//   id, created_time, ad_id, ad_name, adset_id, adset_name, campaign_id,
//   campaign_name, form_id, form_name, is_organic, platform,
//   which_plan_are_you_interested_in?, email_address, phone_number,
//   first_name, lead_status
//
// SETUP NEEDED:
//   1. Vercel dashboard → Storage → Create Database → KV. Connect it to
//      this project. This auto-adds KV_REST_API_URL / KV_REST_API_TOKEN
//      env vars — no manual copying needed.
//   2. `npm install @vercel/kv papaparse` in your project.
//   3. Env var GOOGLE_SHEET_CSV_URL — the export URL below, built from
//      your sheet's ID (already filled in from the link you shared).
//   4. Add a Vercel Cron entry in vercel.json (see note at bottom of this
//      file) to call this endpoint automatically every few minutes.
//      NOTE: Hobby-plan Vercel projects only allow daily cron jobs, not
//      every-few-minutes. Until/unless you're on Pro, call this endpoint
//      manually (or via a free external scheduler like cron-job.org) for
//      near-real-time syncing.

import { kv } from '@vercel/kv';
import Papa from 'papaparse';

const SHEET_ID = '1n-exNxlpQmpe8O9GhrSKhL9rCB-6GI_FN0zK-QS6qi8';
const CSV_URL = process.env.GOOGLE_SHEET_CSV_URL
  || `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

export default async function handler(req, res) {
  // Allow both GET (manual browser trigger / Vercel Cron) and POST.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const ZYRO_BASE = process.env.ZYRO_BASE_URL;
  const API_KEY   = process.env.ZYRO_API_KEY;

  if (!ZYRO_BASE || !API_KEY) {
    console.error('Missing ZYRO_BASE_URL or ZYRO_API_KEY environment variable');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

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

  let created = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    const leadId = row['id'];
    if (!leadId) continue; // blank row

    // ---- Step 2: skip if we've already synced this lead ----
    const alreadyProcessed = await kv.sismember('meta_leads_synced', leadId);
    if (alreadyProcessed) {
      skipped++;
      continue;
    }

    // ---- Step 3: map row → Zyro lead payload ----
    const phone = normalizePhone(row['phone_number']);
    if (!phone) {
      console.warn('META SHEET SYNC: row has no usable phone, skipping', JSON.stringify(row));
      await kv.sadd('meta_leads_synced', leadId); // don't retry a bad row forever
      skipped++;
      continue;
    }

    const name = row['first_name'] || 'Meta Lead Ad enquiry';
    const email = row['email_address'];
    const plan = row['which_plan_are_you_interested_in?'];

    const notes = [
      '*** META LEAD AD (via Google Sheet sync) ***',
      `Plan interest: ${plan || ''}`,
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
          source: 'meta_lead_ads',
          campaign: 'meta_lead_ads_sheet',
          notes
        })
      });

      const lead = await leadRes.json();
      console.log('META SHEET SYNC: lead create', leadId, leadRes.status, JSON.stringify(lead));

      if (leadRes.status === 201) {
        await kv.sadd('meta_leads_synced', leadId);
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

  console.log(`META SHEET SYNC done: ${created} created, ${skipped} skipped, ${failed} failed`);
  return res.status(200).json({ ok: true, created, skipped, failed, totalRows: rows.length });
}

// Meta's sheet sometimes prefixes phone values with "p:" (visible in the
// test row) — strip that and any stray whitespace before sending to Zyro.
function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/^p:/, '').trim();
  if (!cleaned || cleaned.startsWith('<test lead')) return null; // Meta's dummy test row
  return cleaned;
}

// ---- vercel.json cron entry (add this to your project's vercel.json) ----
// {
//   "crons": [
//     { "path": "/api/meta-sheet-sync", "schedule": "0 */6 * * *" }
//   ]
// }
// "0 */6 * * *" = every 6 hours, which is the max frequency allowed on
// Vercel's Hobby plan. On Pro you can go as low as every minute
// ("*/5 * * * *" for every 5 minutes) if you need faster syncing.
