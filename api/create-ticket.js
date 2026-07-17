// api/create-ticket.js
//
// This function receives the "Let's Get You Online" Webflow form submission,
// finds the matching Zyro subscriber, and files a support ticket.
//
// IMPORTANT: fill in the field names below to match your ACTUAL Webflow field
// names (Webflow Designer → click a field → right panel → "Name"). The names
// used here (data.full_name, data.registered_mobile, etc.) are guesses based
// on the labels in your screenshots — they will almost certainly need small
// adjustments once you check the real field names.

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
    let lookupUrl;
    if (data.account_customer_id) {
      lookupUrl = `${ZYRO_BASE}/api/v1/subscribers?account_number=${encodeURIComponent(data.account_customer_id)}`;
    } else if (data.registered_mobile) {
      lookupUrl = `${ZYRO_BASE}/api/v1/subscribers?phone=${encodeURIComponent(data.registered_mobile)}`;
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
    const description = [
      data.specify_issue ? `Issue: ${data.specify_issue}` : null,
      data.previous_ticket_id ? `Follow-up to: ${data.previous_ticket_id}` : null,
      data.describe_the_issue ? `Details: ${data.describe_the_issue}` : null,
      data.troubleshooting_steps ? `Troubleshooting tried: ${data.troubleshooting_steps}` : null,
      data.router_light_status ? `Router light status: ${data.router_light_status}` : null,
      data.preferred_contact_method ? `Preferred contact: ${data.preferred_contact_method}` : null,
      data.best_time_to_call ? `Best time to call: ${data.best_time_to_call}` : null,
      data.alternate_number ? `Alt number: ${data.alternate_number}` : null
    ].filter(Boolean).join('\n');

    // ---- Step 3: create the ticket ----
    const ticketRes = await fetch(`${ZYRO_BASE}/api/v2/tickets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        subscriber_id,
        subject: data.specify_issue || 'Support request via website',
        description,
        priority: data.specify_issue === 'Completely no internet' ? 'high' : 'medium',
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
