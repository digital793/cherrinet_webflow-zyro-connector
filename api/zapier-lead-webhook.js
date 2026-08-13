// api/zapier-lead-webhook.js
//
// Receives a single lead from Zapier (triggered by Meta's native
// "Facebook Lead Ads -> New Lead" Zap) and creates it in Zyro.
//
// FLOW: Meta Lead Ad -> Zapier (New Lead trigger) -> Webhooks by Zapier
//       (POST action) -> this endpoint -> Zyro
//
// WHY THIS REPLACES meta-sheet-sync.js: no shared Google Sheet in the
// middle means nothing to accidentally break by manual edits, no
// polling/onChange triggers needed, and Zapier only fires once per real
// lead — so there's no need for the smembers/sadd dedup-set logic that
// meta-sheet-sync.js needed for its CSV-polling approach. This endpoint
// is intentionally much simpler.
//
// SETUP NEEDED:
//   1. In Zapier: create a Zap with trigger "Facebook Lead Ads -> New
//      Lead". Connect your Meta ad account, pick the Page and the Lead
//      Form(s) that should sync.
//   2. Add action "Webhooks by Zapier -> POST".
//      - URL: https://<your-vercel-app>.vercel.app/api/zapier-lead-webhook
//      - Payload type: json
//      - Data: map Meta's lead fields to this endpoint's expected body
//        keys (see EXPECTED BODY below). Field names coming from Meta's
//        lead form may not match 1:1 -- map them explicitly in Zapier's
//        action editor rather than relying on auto-matching.
//      - Headers: add a header named "x-webhook-secret" with the same
//        value as the ZAPIER_WEBHOOK_SECRET env var below (see step 4).
//   3. In Vercel -> Project -> Settings -> Environment Variables, make
//      sure ZYRO_BASE_URL and ZYRO_API_KEY are already set (same ones
//      used by meta-sheet-sync.js).
//   4. Add a new env var ZAPIER_WEBHOOK_SECRET -- any long random
//      string you generate yourself (e.g. run
//      `openssl rand -hex 32` locally). This prevents randoms on the
//      internet from POSTing fake leads to this public URL. Put the
//      exact same value into the Zapier header in step 2.
//   5. Test: in Zapier, use "Test action" after mapping fields -- it
//      will send one real POST to this endpoint so you can confirm a
//      test lead shows up in Zyro.
//
// EXPECTED BODY (map these keys in Zapier's Webhooks action):
//   {
//     "name": "...",              // lead's first name (or full name)
//     "phone": "...",             // phone number, any format -- normalized below
//     "email": "...",             // optional
//     "zip_code": "...",          // optional
//     "campaign_name": "...",     // optional, Meta's campaign name
//     "form_name": "...",         // optional, Meta's lead form name
//     "plan_interest": "..."      // optional, if your form asks this question
//   }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const ZYRO_BASE = process.env.ZYRO_BASE_URL;
  const API_KEY   = process.env.ZYRO_API_KEY;
  const WEBHOOK_SECRET = process.env.ZAPIER_WEBHOOK_SECRET;

  if (!ZYRO_BASE || !API_KEY) {
    console.error('Missing ZYRO_BASE_URL or ZYRO_API_KEY environment variable');
    return res.status(500).json({ error: 'server_misconfigured' });
  }
  if (!WEBHOOK_SECRET) {
    console.error('Missing ZAPIER_WEBHOOK_SECRET environment variable');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  // ---- Verify the request actually came from our configured Zap ----
  const providedSecret = req.headers['x-webhook-secret'];
  if (providedSecret !== WEBHOOK_SECRET) {
    console.warn('ZAPIER LEAD WEBHOOK: rejected request with invalid/missing secret');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body || {};

  const phone = normalizePhone(body.phone);
  if (!phone) {
    console.warn('ZAPIER LEAD WEBHOOK: no usable phone in payload, rejecting', JSON.stringify(body));
    return res.status(400).json({ error: 'missing_phone' });
  }

  const name = body.name || 'Meta Lead Ad enquiry';
  const email = body.email && body.email !== 'test@meta.com' ? body.email : undefined;
  const zip = normalizeZip(body.zip_code);

  const notes = [
    '*** META LEAD AD (via Zapier) ***',
    `Plan interest: ${body.plan_interest || ''}`,
    `Zip code: ${zip || ''}`,
    `Campaign: ${body.campaign_name || ''}`,
    `Form: ${body.form_name || ''}`,
    '',
    '--- Full payload ---',
    Object.entries(body).map(([k, v]) => `${k}: ${v}`).join('\n')
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
        email,
        zip_code: zip || undefined,
        source: 'website',
        campaign: 'meta_lead_ads_zapier',
        notes
      })
    });

    const lead = await leadRes.json();
    console.log('ZAPIER LEAD WEBHOOK: lead create', leadRes.status, JSON.stringify(lead));

    if (leadRes.status === 201) {
      return res.status(201).json({ ok: true, lead });
    }

    // Zyro rejected it (e.g. duplicate_open_ticket-style error) -- pass
    // its response straight through so Zapier's task history shows the
    // real reason, and so Zapier's own retry/error handling can react.
    console.error('ZAPIER LEAD WEBHOOK: Zyro create failed', leadRes.status, JSON.stringify(lead));
    return res.status(leadRes.status).json({ ok: false, error: 'zyro_create_failed', zyro_response: lead });
  } catch (err) {
    console.error('ZAPIER LEAD WEBHOOK: error creating lead', err);
    return res.status(502).json({ error: 'zyro_request_failed' });
  }
}

// Meta's lead data sometimes prefixes phone values with "p:" depending
// on the source field -- strip that and any stray whitespace before
// sending to Zyro. Safe to run even on already-clean numbers.
function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/^p:/, '').trim();
  if (!cleaned || cleaned.startsWith('<test lead')) return null; // Meta's dummy test lead
  return cleaned;
}

// Same deal as phone: strip a possible "z:" prefix and ignore the dummy
// test lead value.
function normalizeZip(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/^z:/, '').trim();
  if (!cleaned || cleaned.startsWith('<test lead')) return null;
  return cleaned;
}
