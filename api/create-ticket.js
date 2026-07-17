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

    // ---- Step 2: build a description from all the extra form fields ----
    const specifyIssue   = data['Specify issue'];
    const description = [
      data.issue_type ? `Issue type: ${data.issue_type}` : null,
      specifyIssue ? `Issue: ${specifyIssue}` : null,
      data['Previous Ticket ID'] ? `Follow-up to: ${data['Previous Ticket ID']}` : null,
      data['Describe the issue'] ? `Details: ${data['Describe the issue']}` : null,
      data.Troubleshooting ? `Troubleshooting tried: ${data.Troubleshooting}` : null,
      data.router_status ? `Router light status: ${data.router_status}` : null,
      data.contact_method ? `Preferred contact: ${data.contact_method}` : null,
      data['Best time to call *'] ? `Best time to call: ${data['Best time to call *']}` : null,
      data['Alternative Phone Number'] ? `Alt number: ${data['Alternative Phone Number']}` : null,
      data.Email ? `Email: ${data.Email}` : null,
      data.Evidence ? `Evidence attachment: ${data.Evidence}` : null
    ].filter(Boolean).join('\n');

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
