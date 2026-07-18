// api/create-lead.js
//
// Receives submissions from any of the 3 "support-form" page forms
// (New connection / For Business (ILL) / Ask a question) and files a lead
// in Zyro via POST /api/v2/webhooks/leads.
//
// IMPORTANT: field names below are BEST-GUESS based on the labels visible
// on https://cherrinet-commercial.webflow.io/support-form. We haven't seen
// the raw Webflow payload for these forms yet (unlike the complaint form,
// where we corrected names after seeing a real submission). Once you test
// each form, check the Vercel log line "RAW LEAD PAYLOAD" and send it to me
// so we can fix any mismatched field names, same as we did for the ticket form.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const ZYRO_BASE = process.env.ZYRO_BASE_URL;        // same tenant base as tickets
  const LEADS_API_KEY = process.env.ZYRO_LEADS_API_KEY; // separate service-account key
                                                          // scoped to :create_leads_via_api
                                                          // (can be the same key as tickets
                                                          // ONLY if that service account also
                                                          // holds this permission — check with
                                                          // your Zyro admin)

  if (!ZYRO_BASE || !LEADS_API_KEY) {
    console.error('Missing ZYRO_BASE_URL or ZYRO_LEADS_API_KEY environment variable');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const headers = {
    'Authorization': `Bearer ${LEADS_API_KEY}`,
    'Content-Type': 'application/json'
  };

  const data = req.body.data || req.body;

  // TEMPORARY DEBUG LOG — remove once field names are confirmed for all 3 forms.
  console.log('RAW LEAD PAYLOAD:', JSON.stringify(req.body));

  try {
    // ---- Step 1: figure out which of the 3 forms this came from ----
    // Distinguishing fields per form (based on the visible labels):
    //   Business (ILL):    "Company name", "Industry", "Designation", "Work email"
    //   Ask a question:    "Ask your question"
    //   New connection:    "Preferred plan", "PIN code" (and none of the above)
    let formType;
    if (data['Company name'] || data['Industry'] || data['Designation'] || data['Work email']) {
      formType = 'business';
    } else if (data['Ask your question']) {
      formType = 'question';
    } else {
      formType = 'new_connection';
    }

    // ---- Step 2: map to the lead payload fields Zyro expects ----
    // No native "customer vs business" field exists on Zyro's lead schema
    // (see integration docs, section 11.2) — so we tag via `campaign`
    // (filterable in Zyro Console) and a bold banner at the top of `notes`
    // (unmissable to any agent opening the lead).
    let name, phone, email, address, pincode, notesExtra, campaign, banner;

    if (formType === 'business') {
      campaign = 'business_ill';
      banner   = '*** BUSINESS LEAD (ILL) ***';
      name    = data['Full name'] || data['Company name'];
      phone   = data['Mobile number'] || data['Alternate phone'];
      email   = data['Work email'];
      pincode = data['PIN code'];
      address = data['District'] ? `District: ${data['District']}` : undefined;
      notesExtra = `Company: ${data['Company name'] || ''}\nIndustry: ${data['Industry'] || ''}\nGSTIN: ${data['GSTIN'] || ''}\nDesignation: ${data['Designation'] || ''}`;
    } else if (formType === 'question') {
      campaign = 'general_question';
      banner   = '*** GENERAL QUESTION ***';
      name    = data['Full name'];
      phone   = data['Mobile number'];
      email   = data['Email address'];
      notesExtra = `Question: ${data['Ask your question'] || ''}`;
    } else {
      campaign = 'new_connection_residential';
      banner   = '*** RESIDENTIAL / NEW CONNECTION LEAD ***';
      name    = data['Full name'];
      phone   = data['Mobile number'];
      email   = data['Email address'];
      pincode = data['PIN code'];
      address = data['District'] ? `District: ${data['District']}` : undefined;
      notesExtra = `Preferred plan: ${data['Preferred plan'] || ''}\nOTT add-on: ${data['Choose your OTT add on'] || data['OTT add on'] || ''}`;
    }

    if (!phone) {
      return res.status(400).json({ error: 'missing_phone' });
    }

    // Dump every submitted field into notes too, so nothing gets lost even
    // if our field-name guesses above are slightly off.
    const fullDump = Object.entries(data)
      .filter(([key, value]) => key !== 'Privacy Policy' && value !== undefined && value !== null && String(value).trim() !== '')
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');

    const notes = `${banner}\n${notesExtra}\n\n--- Full submission ---\n${fullDump}`;

    // ---- Step 3: create the lead ----
    const leadRes = await fetch(`${ZYRO_BASE}/api/v2/webhooks/leads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: name || 'Website enquiry',
        phone,
        email: email || undefined,
        address,
        pincode,
        source: 'website',
        campaign,
        notes
      })
    });

    const lead = await leadRes.json();

    console.log('LEAD CREATE STATUS:', leadRes.status);
    console.log('LEAD CREATE RESPONSE:', JSON.stringify(lead));

    if (leadRes.status === 201) {
      return res.status(200).json({
        ok: true,
        lead_id: lead.id,
        message: lead.message
      });
    }

    if (leadRes.status === 422) {
      return res.status(422).json({
        error_message: 'Please check your details and try again.',
        details: lead.details
      });
    }

    console.error('Zyro lead create failed:', leadRes.status, lead);
    return res.status(500).json({ error: 'lead_creation_failed' });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
