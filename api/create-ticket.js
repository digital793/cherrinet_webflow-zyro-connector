// api/create-ticket.js
//
// Receives the "Let's Get You Online" / Complaint Form Webflow submission,
// finds the matching Zyro subscriber, and files a support ticket.
//
// Field names below are confirmed from the actual Webflow payload logged on
// 2026-07-17 (see the RAW WEBFLOW PAYLOAD debug line), EXCEPT
// `issue_category` (the top-level "What's the issue about?" button group) —
// double check that key against your real Webflow field name and update the
// map below (and the `data.issue_category` references) if it differs.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const ZYRO_BASE = process.env.ZYRO_BASE_URL;   // e.g. https://tickets.knet.co.in
  const API_KEY   = process.env.ZYRO_API_KEY;    // your ticket-only zyro_ak_... key

  if (!ZYRO_BASE || !API_KEY) {
    console.error('Missing ZYRO_BASE_URL or ZYRO_API_KEY environment variable');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const headers = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json'
  };

  // Webflow sends the submitted fields inside req.body.data
  const data = req.body.data || req.body;

  // ---- Top-level "What's the issue about?" -> Zyro intake_sub_category_id ----
  // Keep this deliberately simple: just enough to satisfy Zyro's required
  // field. Everything else (specify issue, troubleshooting, router status,
  // contact prefs, etc.) goes into the description as plain label: value text.
  const SUB_CATEGORY_MAP = {
    'No internet/disconnection': 1,   // connectivity
    'Slow speeds/drops':         2,   // speed
    'Billing/Payment issue':     3,   // billing
    'Installation/Shifting':     4,   // installation
    'Router/Hardware':           1,   // connectivity (closest fit)
    'Other/General query':       8    // general
  };

  try {
    // ---- Step 1: find the subscriber ----
    const accountId = data['Account/ Customer ID'];
    const phone     = data['Phone Number'] || data['Registered Mobile'];

    let lookupUrl;
    if (accountId) {
      lookupUrl = `${ZYRO_BASE}/api/v1/subscribers?account_number=${encodeURIComponent(accountId)}`;
    } else if (phone) {
      lookupUrl = `${ZYRO_BASE}/api/v1/subscribers?phone=${encodeURIComponent(phone)}`;
    } else {
      return res.status(400).json({ error: 'missing_identifier' });
    }

    const lookupRes = await fetch(lookupUrl, { headers });
    const lookup = await lookupRes.json();

    if (!lookup.total) {
      return res.status(404).json({
        error_message: "We couldn't match this to an existing account. Please double check your Account/Customer ID or registered mobile number."
      });
    }

    const subscriber_id = lookup.data[0].id;

    // ---- Step 2: build a description from every form field, label: value ----
    const issueCategory = data.issue_category; // <-- verify this key name in Webflow
    const specifyIssue  = data['Specify issue'];

    const description = [
      issueCategory ? `Issue category: ${issueCategory}` : null,
      specifyIssue ? `Specify issue: ${specifyIssue}` : null,
      data['Previous Ticket ID'] ? `Previous ticket ID: ${data['Previous Ticket ID']}` : null,
      data['Describe the issue'] ? `Describe the issue: ${data['Describe the issue']}` : null,
      data['Troubleshooting steps'] ? `Troubleshooting steps: ${data['Troubleshooting steps']}` : null,
      data['Router Light Status'] ? `Router light status: ${data['Router Light Status']}` : null,
      data['Preferred contact method'] ? `Preferred contact method: ${data['Preferred contact method']}` : null,
      data['Best time to call'] ? `Best time to call: ${data['Best time to call']}` : null,
      data['Alternate number'] ? `Alternate number: ${data['Alternate number']}` : null,
      data['Full Name'] ? `Full name: ${data['Full Name']}` : null,
      data['Email Address'] ? `Email address: ${data['Email Address']}` : null
    ].filter(Boolean).join('\n');

    const sub_category_id = SUB_CATEGORY_MAP[issueCategory] || 8; // fallback: general

    // ---- Step 3: create the ticket ----
    const ticketRes = await fetch(`${ZYRO_BASE}/api/v2/tickets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        subscriber_id,
        subject: specifyIssue || issueCategory || 'Support request via website',
        description,
        sub_category_id,
        priority: (issueCategory === 'No internet/disconnection' || specifyIssue === 'Completely no internet')
          ? 'high'
          : 'medium',
        source: 'portal'
      })
    });

    const ticket = await ticketRes.json();

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

    if (ticketRes.status === 422) {
      console.error('Zyro validation failed:', ticket);
      return res.status(422).json({
        error_message: 'There was a problem with the ticket details. Our team has been notified.'
      });
    }

    console.error('Zyro ticket create failed:', ticketRes.status, ticket);
    return res.status(500).json({ error: 'ticket_creation_failed' });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
