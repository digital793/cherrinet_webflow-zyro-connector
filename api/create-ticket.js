// api/create-ticket.js
//
// Receives the "Complaint form" (a.k.a. "Let's Get You Online") Webflow
// submission, finds the matching Zyro subscriber, and files a support ticket.
//
// Field names below are CONFIRMED from real Webflow webhook payloads (not
// guesses) — see data['...'] bracket access, needed because several field
// names contain spaces or slashes.

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

  const data = req.body.data || req.body;

  try {
    // ---- Step 1: find the subscriber ----
    // Prefer Account/Customer ID (most stable), fall back to phone number.
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

    // ---- Step 2: build a description from everything without a dedicated Zyro field ----
    const description = [
      data['Specify issue']              ? `Specific issue: ${data['Specify issue']}` : null,
      data['Previous Ticket ID']         ? `Follow-up to ticket: ${data['Previous Ticket ID']}` : null,
      data['Describe the issue']         ? `Customer description: ${data['Describe the issue']}` : null,
      data['Troubleshooting']            ? `Troubleshooting tried: ${data['Troubleshooting']}` : null,
      data['router_status']              ? `Router light status: ${data['router_status']}` : null,
      data['contact_method']             ? `Preferred contact: ${data['contact_method']}` : null,
      data['Best time to call *']        ? `Best time to call: ${data['Best time to call *']}` : null,
      data['Alternative Phone Number']   ? `Alt number: ${data['Alternative Phone Number']}` : null
    ].filter(Boolean).join('\n');

    // ---- Step 3: map the category card to a Zyro sub_category_id ----
    // NOTE: verify these IDs against your live tenant via GET /api/v2/ticket-taxonomy
    // before relying on this in production — sample IDs from the spec docs are shown here.
    const subCategoryMap = {
      'no_internet': 12,
      'slow_speed': 13,
      'billing': 21,
      'installation': 47,
      'router_hardware': 14,
      'general': null
    };
    const sub_category_id = subCategoryMap[data['issue_type']] ?? null;

    // ---- Step 4: create the ticket ----
    const ticketRes = await fetch(`${ZYRO_BASE}/api/v2/tickets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        subscriber_id,
        subject: data['Specify issue'] || data['issue_type'] || 'Support request via website',
        description,
        ...(sub_category_id ? { sub_category_id } : {}),
        priority: data['issue_type'] === 'no_internet' ? 'high' : 'medium',
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

    console.error('Zyro ticket create failed:', ticketRes.status, JSON.stringify(ticket));
    return res.status(500).json({ error: 'ticket_creation_failed' });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
