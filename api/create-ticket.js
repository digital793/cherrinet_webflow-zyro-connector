// api/create-ticket.js
//
// Receives the "Let's Get You Online" Webflow form submission, finds the
// matching Zyro subscriber, and files a support ticket.
//
// Field names below are confirmed from the actual Webflow payload logged on
// 2026-07-17 (see the RAW WEBFLOW PAYLOAD debug line). If you rename fields
// in the Webflow Designer later, update the keys here to match.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const ZYRO_BASE = process.env.ZYRO_BASE_URL;   // e.g. https://your-tenant.zyro.io
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

  try {
    // ---- Step 1: find the subscriber ----
    const accountId = data['Account/ Customer ID'];
    const phone     = data['Phone Number'];

    if (!accountId && !phone) {
      return res.status(400).json({ error: 'missing_identifier' });
    }

    async function lookupBy(param, value) {
      const url = `${ZYRO_BASE}/api/v1/subscribers?${param}=${encodeURIComponent(value)}`;
      console.log('LOOKUP URL:', url);
      const r = await fetch(url, { headers });
      const j = await r.json();
      console.log('LOOKUP STATUS:', r.status, 'RESPONSE:', JSON.stringify(j));
      return j;
    }

    // Try account ID first (more precise), fall back to phone if no match.
    let lookup = { total: 0 };
    if (accountId) {
      lookup = await lookupBy('account_number', accountId);
    }
    if (!lookup.total && phone) {
      lookup = await lookupBy('phone', phone);
    }

    if (!lookup.total) {
      return res.status(404).json({
        error_message: "We couldn't match this to an existing account. Please double check your Account/Customer ID or registered mobile number."
      });
    }

    const subscriber_id = lookup.data[0].id;

    // ---- Step 2: build a description from every submitted form field ----
    const specifyIssue = data['Specify issue'];

    // Fields we don't want repeated in the free-text body (already used
    // elsewhere, or not useful to a support agent reading the ticket).
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
        source: 'portal'
        // sub_category_id intentionally left out for now — add once you've
        // pulled real IDs from GET /api/v2/ticket-taxonomy
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

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
