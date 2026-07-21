// api/webflow-intake.js
//
// SINGLE endpoint for ALL Webflow forms on the site (complaint form + the
// 3 lead forms on /support-form). Every form's "Send to" should point at
// this one URL — nothing else. This function inspects the submitted
// fields and decides internally whether it's a support ticket or a lead
// (and which kind of lead), then calls the matching logic below.
//
// WHY ONE FILE: Webflow's per-form "Send to" list is tied directly to the
// site's global webhook registrations — removing a destination from one
// form's list deletes that webhook globally, not just for that form. Using
// a single shared URL for every form avoids ever needing to pick/remove
// destinations per form again.
//
// FIELD NAMES CONFIRMED 2026-07-20 from the "New Connection Form" RAW
// WEBFLOW PAYLOAD log: Name, Phone Number, Email, Pin Code, District,
// Preferred Plan, ADD on, Privacy Policy. The "business" and "question"
// tabs on /support-form have NOT been confirmed yet — their field names
// below are still best-guess placeholders. Verify those the same way once
// you have a raw payload log for each.

export default async function handler(req, res) {
  // ---- CORS ----
  // Webflow FORM submissions happen server-side (Webflow calls this
  // webhook directly), so they never hit CORS. The chatbot is different:
  // it runs client-side JS in the visitor's browser, so fetch() from
  // cherrinet-commercial.webflow.io to this Vercel domain is cross-origin.
  // The browser sends an OPTIONS preflight first; without these headers
  // it gets rejected before the real POST is ever sent.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // ---- Chatbot payloads look like { type: 'Complaint', fields: {...} } ----
  // Webflow payloads look like { name, site, data: {...}, ... }.
  // Check for the bot shape FIRST so it never falls through into the
  // Webflow-field-sniffing logic below.
  if (req.body && req.body.type && req.body.fields) {
    console.log('RAW BOT PAYLOAD:', JSON.stringify(req.body));
    try {
      return await handleBotSubmission(req.body.type, req.body.fields, res);
    } catch (err) {
      console.error('Unexpected error (bot path):', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  const data = req.body.data || req.body;

  // TEMPORARY DEBUG LOG — safe to keep short-term while confirming routing;
  // remove once you've verified every form classifies correctly.
  console.log('RAW WEBFLOW PAYLOAD:', JSON.stringify(req.body));

  // ---- Routing: decide ticket vs lead based on which fields are present ----
  // Only the complaint form has these fields (see the confirmed payload from
  // 2026-07-17): Troubleshooting, router_status, Describe the issue.
  const isTicket = Boolean(
    data['Troubleshooting'] || data['router_status'] || data['Describe the issue']
  );

  try {
    if (isTicket) {
      return await handleTicket(data, res);
    } else {
      return await handleLead(data, res);
    }
  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

// =====================================================================
// TICKET path — complaint form → POST /api/v2/tickets
// =====================================================================
async function handleTicket(data, res) {
  const ZYRO_BASE = process.env.ZYRO_BASE_URL;
  const API_KEY   = process.env.ZYRO_API_KEY;

  if (!ZYRO_BASE || !API_KEY) {
    console.error('Missing ZYRO_BASE_URL or ZYRO_API_KEY environment variable');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const headers = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json'
  };

  // ---- Step 1: find the subscriber (by phone number only) ----
  const phone = data['Phone Number'];

  if (!phone) {
    return res.status(400).json({ error: 'missing_identifier' });
  }

  const lookupUrl = `${ZYRO_BASE}/api/v1/subscribers?phone=${encodeURIComponent(phone)}`;
  console.log('LOOKUP URL:', lookupUrl);

  const lookupRes = await fetch(lookupUrl, { headers });
  const lookup = await lookupRes.json();

  console.log('LOOKUP STATUS:', lookupRes.status, 'RESPONSE:', JSON.stringify(lookup));

  if (!lookup.total) {
    return res.status(404).json({
      error_message: "We couldn't match this to an existing account. Please double check your registered mobile number."
    });
  }

  const subscriber_id = lookup.data[0].id;

  // ---- Step 2: build a description from every submitted form field ----
  const specifyIssue = data['Specify issue'];

  function mapSubCategoryId(issueValue) {
    const v = (issueValue || '').toLowerCase();
    if (v.includes('intermittent') || v.includes('drop')) return 13; // Frequent disconnection
    if (v.includes('wifi') || v.includes('wi-fi') || v.includes('one device')) return 16; // LAN/WIFI issue
    if (v.includes('no internet') || v.includes('all device') || v.includes('no access')) return 14; // Unable to browse
    return 14; // default fallback: Unable to browse
  }
  const sub_category_id = mapSubCategoryId(specifyIssue);

  const EXCLUDE_FROM_DESCRIPTION = new Set(['Privacy Policy']);

  const description = Object.entries(data)
    .filter(([key, value]) => {
      if (EXCLUDE_FROM_DESCRIPTION.has(key)) return false;
      return value !== undefined && value !== null && String(value).trim() !== '';
    })
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  // ---- Step 3: create the ticket ----
  const ticketRes = await fetch(`${ZYRO_BASE}/api/v2/tickets`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      subscriber_id,
      subject: specifyIssue || data.issue_type || 'Support request via website',
      description,
      priority: (data.issue_type === 'no_internet' || specifyIssue === 'completely_no_internet')
        ? 'high'
        : 'medium',
      sub_category_id,
      source: 'portal'
    })
  });

  const ticket = await ticketRes.json();

  console.log('TICKET CREATE STATUS:', ticketRes.status);
  console.log('TICKET CREATE RESPONSE:', JSON.stringify(ticket));

  if (ticketRes.status === 201) {
    return res.status(200).json({
      ok: true,
      ticket_number: ticket.data.ticket_number
    });
  }

  if (ticketRes.status === 409) {
    return res.status(409).json({
      error_message: `You already have an open ticket (${ticket.existing.ticket_number}). Our team is already on it.`
    });
  }

  console.error('Zyro ticket create failed:', ticketRes.status, ticket);
  return res.status(500).json({ error: 'ticket_creation_failed' });
}

// =====================================================================
// LEAD path — 3 support-form tabs → POST /api/v2/webhooks/leads
// =====================================================================
async function handleLead(data, res) {
  const ZYRO_BASE = process.env.ZYRO_BASE_URL;
  // Reusing the same key as the ticket path — this service account
  // ("Website") now carries both create_tickets and create_leads_via_api.
  const LEADS_API_KEY = process.env.ZYRO_API_KEY;

  if (!ZYRO_BASE || !LEADS_API_KEY) {
    console.error('Missing ZYRO_BASE_URL or ZYRO_API_KEY environment variable');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const headers = {
    'Authorization': `Bearer ${LEADS_API_KEY}`,
    'Content-Type': 'application/json'
  };

  // ---- Step 1: figure out which of the 3 lead forms this came from ----
  // NOTE: 'business' and 'question' field names below are still
  // UNVERIFIED placeholders. Only 'new_connection' has been confirmed
  // against a real payload (2026-07-20).
  let formType;
  if (data['Company name'] || data['Industry'] || data['Designation'] || data['Work email']) {
    formType = 'business';
  } else if (data['Ask your question']) {
    formType = 'question';
  } else {
    formType = 'new_connection';
  }

  // ---- Step 2: map to the lead payload fields Zyro expects ----
  let name, phone, email, address, pincode, notesExtra, campaign, banner;

  if (formType === 'business') {
    // CONFIRMED 2026-07-20 against the "Business Enquiry" payload.
    campaign = 'business_ill';
    banner   = '*** BUSINESS LEAD (ILL) ***';
    name    = data['Name'] || data['Company name'];
    phone   = data['Phone Number'] || data['Alternative Phone Number'];
    email   = data['Email'];
    pincode = data['Pin Code'];
    address = data['District'] ? `District: ${data['District']}` : undefined;
    notesExtra = `Company: ${data['Company name'] || ''}\nIndustry: ${data['Industry'] || ''}\nGSTIN: ${data['GSTIN (optional)'] || ''}\nDesignation: ${data['Designation'] || ''}`;
  } else if (formType === 'question') {
    // UNVERIFIED — confirm real field names before relying on this branch.
    campaign = 'general_question';
    banner   = '*** GENERAL QUESTION ***';
    name    = data['Full name'];
    phone   = data['Mobile number'];
    email   = data['Email address'];
    notesExtra = `Question: ${data['Ask your question'] || ''}`;
  } else {
    // CONFIRMED 2026-07-20 against the "New Connection Form" payload.
    campaign = 'new_connection_residential';
    banner   = '*** RESIDENTIAL / NEW CONNECTION LEAD ***';
    name    = data['Name'];
    phone   = data['Phone Number'];
    email   = data['Email'];
    pincode = data['Pin Code'];
    address = data['District'] ? `District: ${data['District']}` : undefined;
    notesExtra = `Preferred plan: ${data['Preferred Plan'] || ''}\nOTT add-on: ${data['ADD on'] || ''}`;
  }

  if (!phone) {
    return res.status(400).json({ error: 'missing_phone' });
  }

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
}

// =====================================================================
// CHATBOT path — cherri.html widget → this same Vercel endpoint
// Payload shape: { type: 'Complaint' | 'Direct Enquiry' | 'New Connection'
//                       | 'Business ILL Enquiry' | 'Coverage Notify',
//                   fields: { ...whatever that flow collected } }
// =====================================================================
async function handleBotSubmission(type, fields, res) {
  if (type === 'Complaint') {
    return await handleBotComplaint(fields, res);
  }
  return await handleBotLead(type, fields, res);
}

// ---- Bot Complaint → POST /api/v2/tickets ----
async function handleBotComplaint(fields, res) {
  const ZYRO_BASE = process.env.ZYRO_BASE_URL;
  const API_KEY   = process.env.ZYRO_API_KEY;

  if (!ZYRO_BASE || !API_KEY) {
    console.error('Missing ZYRO_BASE_URL or ZYRO_API_KEY environment variable');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const headers = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json'
  };

  const phone = fields['Mobile'];
  if (!phone) {
    return res.status(400).json({ error: 'missing_identifier' });
  }

  const lookupUrl = `${ZYRO_BASE}/api/v1/subscribers?phone=${encodeURIComponent(phone)}`;
  const lookupRes = await fetch(lookupUrl, { headers });
  const lookup = await lookupRes.json();

  console.log('BOT LOOKUP STATUS:', lookupRes.status, 'RESPONSE:', JSON.stringify(lookup));

  if (!lookup.total) {
    return res.status(404).json({
      error_message: "We couldn't match this to an existing account. Please double check your registered mobile number."
    });
  }

  const subscriber_id = lookup.data[0].id;

  function mapSubCategoryId(issueType) {
    const v = (issueType || '').toLowerCase();
    if (v.includes('slow') || v.includes('drop')) return 13;       // Frequent disconnection
    if (v.includes('router') || v.includes('hardware')) return 16; // LAN/WIFI issue
    if (v.includes('no internet') || v.includes('disconnection')) return 14; // Unable to browse
    return 14; // default fallback
  }
  const sub_category_id = mapSubCategoryId(fields['Issue Type']);

  function mapPriority(urgency) {
    const v = (urgency || '').toLowerCase();
    if (v === 'high') return 'high';
    if (v === 'low') return 'low';
    return 'medium';
  }

  const description = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '' && value !== '—')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  const ticketRes = await fetch(`${ZYRO_BASE}/api/v2/tickets`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      subscriber_id,
      subject: fields['Issue Type'] || 'Support request via chatbot',
      description,
      sub_category_id,
      priority: mapPriority(fields['Urgency']),
      source: 'portal'
    })
  });

  const ticket = await ticketRes.json();
  console.log('BOT TICKET CREATE STATUS:', ticketRes.status, JSON.stringify(ticket));

  if (ticketRes.status === 201) {
    return res.status(200).json({ ok: true, ticket_number: ticket.data.ticket_number });
  }

  if (ticketRes.status === 409) {
    return res.status(409).json({
      error_message: `You already have an open ticket (${ticket.existing.ticket_number}). Our team is already on it.`
    });
  }

  console.error('Zyro bot ticket create failed:', ticketRes.status, ticket);
  return res.status(500).json({ error: 'ticket_creation_failed' });
}

// ---- Bot leads (4 flows) → POST /api/v2/webhooks/leads ----
async function handleBotLead(type, fields, res) {
  const ZYRO_BASE = process.env.ZYRO_BASE_URL;
  const API_KEY   = process.env.ZYRO_API_KEY; // same key, carries both permissions

  if (!ZYRO_BASE || !API_KEY) {
    console.error('Missing ZYRO_BASE_URL or ZYRO_API_KEY environment variable');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const headers = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json'
  };

  let name, phone, email, address, pincode, campaign, banner;

  switch (type) {
    case 'Direct Enquiry':
      campaign = 'bot_direct_enquiry';
      banner   = '*** DIRECT ENQUIRY (CHATBOT) ***';
      name     = fields['Name'];
      phone    = fields['Mobile'];
      email    = fields['Email'] !== '—' ? fields['Email'] : undefined;
      address  = fields['Area'];
      break;

    case 'New Connection':
      campaign = 'bot_new_connection';
      banner   = '*** NEW CONNECTION (CHATBOT) ***';
      name     = fields['Name'];
      phone    = fields['Mobile'];
      email    = fields['Email'] !== '—' ? fields['Email'] : undefined;
      pincode  = fields['PIN'];
      address  = fields['Address'];
      break;

    case 'Business ILL Enquiry':
      campaign = 'bot_business_ill';
      banner   = '*** BUSINESS ILL ENQUIRY (CHATBOT) ***';
      name     = fields['Contact Name'] || fields['Company Name'];
      phone    = fields['Mobile'] || fields['Alternate Phone'];
      email    = fields['Work Email'];
      pincode  = fields['PIN Code'];
      address  = fields['District'] ? `District: ${fields['District']}` : undefined;
      break;

    case 'Coverage Notify':
      campaign = 'bot_coverage_notify';
      banner   = '*** COVERAGE NOTIFY (CHATBOT) ***';
      name     = fields['Name'];
      phone    = fields['Mobile'];
      pincode  = fields['PIN'];
      break;

    default:
      // Unknown bot flow type — still try to capture something rather than
      // silently dropping the submission.
      campaign = 'bot_other';
      banner   = `*** ${type || 'UNKNOWN'} (CHATBOT) ***`;
      name     = fields['Name'] || fields['Contact Name'];
      phone    = fields['Mobile'];
      email    = fields['Email'];
  }

  if (!phone) {
    return res.status(400).json({ error: 'missing_phone' });
  }

  const fullDump = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '' && value !== '—')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  const notes = `${banner}\n\n${fullDump}`;

  const leadRes = await fetch(`${ZYRO_BASE}/api/v2/webhooks/leads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: name || 'Chatbot enquiry',
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
  console.log('BOT LEAD CREATE STATUS:', leadRes.status, JSON.stringify(lead));

  if (leadRes.status === 201) {
    return res.status(200).json({ ok: true, lead_id: lead.id, message: lead.message });
  }

  if (leadRes.status === 422) {
    return res.status(422).json({
      error_message: 'Please check your details and try again.',
      details: lead.details
    });
  }

  console.error('Zyro bot lead create failed:', leadRes.status, lead);
  return res.status(500).json({ error: 'lead_creation_failed' });
}
