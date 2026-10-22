
/**
 * api/gallabox-webhook.js
 *
 * Gallabox WhatsApp -> Vercel -> Zyro Leads API
 *
 * Vercel environment variables:
 *   ZYRO_BASE_URL=https://tickets.knet.co.in
 *   ZYRO_API_KEY=your_existing_zyro_api_key
 *   GALLABOX_WEBHOOK_SECRET=your_existing_webhook_secret
 *
 * Gallabox webhook:
 *   POST /api/gallabox-webhook?secret=YOUR_SECRET
 */

function cleanString(value) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  return "";
}

function getHeader(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getPayloadRoot(body) {
  if (
    body?.data &&
    typeof body.data === "object" &&
    !Array.isArray(body.data)
  ) {
    return body.data;
  }
  return body;
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanString(value);
    if (text) return text;
  }
  return "";
}

function extractWhatsAppMessage(body) {
  const root = getPayloadRoot(body);

  const candidates = [
    root.whatsapp?.text?.body,
    body.whatsapp?.text?.body,
    root.message?.text?.body,
    root.message?.text,
    root.message?.body,
    root.text?.body,
    root.text,
    root.whatsapp?.body,
    root.messageText,
    root.content,
    body.messageText,
    body.content,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
}

function buildLead(body) {
  const root = getPayloadRoot(body);

  const contact = root.contact || body.contact || {};
  const whatsapp = root.whatsapp || body.whatsapp || {};

  const rawPhone = firstText(
    whatsapp.from,
    root.from,
    contact.phone,
    contact.phoneNumber
  );

  if (!rawPhone) {
    console.error("GALLABOX_MISSING_PHONE", {
      rootKeys: Object.keys(root),
      bodyKeys: Object.keys(body),
      whatsappKeys: Object.keys(whatsapp),
      contactKeys: Object.keys(contact),
    });

    return { error: "missing_phone" };
  }

  // Preserve the international prefix and remove formatting characters.
  const phone = rawPhone.replace(/[^\d+]/g, "");

  if (phone.replace(/\D/g, "").length < 8) {
    return { error: "invalid_phone" };
  }

  const name = firstText(
    contact.name,
    root.name,
    body.name
  ) || "WhatsApp enquiry";

  const email = firstText(
    contact.email,
    root.email,
    body.email
  );

  const message = extractWhatsAppMessage(body);

  const conversationId = firstText(
    root.conversationId,
    body.conversationId
  );

  const contactId = firstText(
    root.contactId,
    contact.id,
    body.contactId
  );

  const eventId = firstText(
    root.id,
    root.localMessageId,
    body.id,
    body.localMessageId
  );

  const messageType = firstText(
    whatsapp.type,
    root.type,
    body.type
  );

  const notes = [
    "GALLABOX WHATSAPP ENQUIRY",
    `Customer message: ${
      message || (
        messageType && messageType.toLowerCase() !== "text"
          ? `[${messageType} message; no text body supplied]`
          : "Message text unavailable in webhook payload"
      )
    }`,
    `Conversation ID: ${conversationId || "Not supplied"}`,
    `Contact ID: ${contactId || "Not supplied"}`,
    `Message ID: ${eventId || "Not supplied"}`,
  ].join("\n");

  // "whatsapp" was rejected by Zyro's source validation.
  // "website" is used by the existing working lead integrations.
  // This is a workaround, not a true WhatsApp source classification.
  const payload = {
    name,
    phone,
    ...(email ? { email } : {}),
    source: "website",
    campaign: "gallabox_whatsapp_high_priority",
    notes,
  };

  return {
    payload,
    eventId,
    conversationId,
    contactId,
    hasMessage: Boolean(message),
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const expectedSecret = process.env.GALLABOX_WEBHOOK_SECRET;

  const suppliedSecret =
    getHeader(req, "x-webhook-secret") ||
    cleanString(req.query?.secret);

  if (
    !expectedSecret ||
    !suppliedSecret ||
    suppliedSecret !== expectedSecret
  ) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const zyroBaseUrl = process.env.ZYRO_BASE_URL;
  const zyroApiKey = process.env.ZYRO_API_KEY;

  if (!zyroBaseUrl || !zyroApiKey) {
    console.error("GALLABOX_CONFIG_ERROR", {
      hasZyroBaseUrl: Boolean(zyroBaseUrl),
      hasZyroApiKey: Boolean(zyroApiKey),
    });

    return res.status(500).json({ error: "server_misconfigured" });
  }

  let body = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "invalid_json" });
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  const lead = buildLead(body);

  if (lead.error) {
    return res.status(422).json({
      error: lead.error,
      message: "Check the Gallabox contact phone number.",
    });
  }

  try {
    const endpoint =
      `${zyroBaseUrl.replace(/\/+$/, "")}` +
      "/api/v2/webhooks/leads";

    const zyroResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${zyroApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(lead.payload),
    });

    const responseText = await zyroResponse.text();

    let result = {};
    try {
      result = responseText ? JSON.parse(responseText) : {};
    } catch {
      result = {};
    }

    if (zyroResponse.ok) {
      console.log("GALLABOX_ZYRO_LEAD_CREATED", {
        status: zyroResponse.status,
        eventIdPresent: Boolean(lead.eventId),
        messageFound: lead.hasMessage,
      });

      return res.status(200).json({
        ok: true,
        source: "website",
        priority_label: "high",
        message_found: lead.hasMessage,
        zyro_status: zyroResponse.status,
        lead_id: result.id || result.leadId || null,
      });
    }

    // Do not log credentials, cookies, or the submitted contact details.
    console.error("ZYRO_LEAD_REJECTION", {
      status: zyroResponse.status,
      response: responseText.slice(0, 1500),
    });

    return res.status(502).json({
      error: "zyro_lead_creation_failed",
      zyro_status: zyroResponse.status,
    });
  } catch (error) {
    console.error("GALLABOX_ZYRO_REQUEST_FAILED", {
      message: error?.message || "unknown_error",
    });

    return res.status(502).json({ error: "zyro_request_failed" });
  }
}
