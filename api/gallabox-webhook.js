
/**
 * api/gallabox-webhook.js
 *
 * Gallabox WhatsApp -> Vercel -> Zyro Leads API
 *
 * Required Vercel environment variables:
 *   ZYRO_BASE_URL
 *   ZYRO_API_KEY
 *   GALLABOX_WEBHOOK_SECRET
 *
 * Endpoint:
 *   /api/gallabox-webhook?secret=YOUR_SECRET
 *
 * Important:
 * - Phone mapping uses the confirmed Gallabox field whatsapp.from.
 * - Zyro's accepted fields must match its API contract.
 * - High priority is labelled in campaign/notes, not guaranteed
 *   to set a native Zyro priority field.
 * - Persistent duplicate protection is not included.
 */

function cleanString(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }

  return String(value).trim();
}

function getHeader(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function redactSensitiveData(value) {
  return String(value)
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[REDACTED_EMAIL]"
    )
    .replace(
      /\+?\d[\d\s().-]{7,}\d/g,
      "[REDACTED_PHONE]"
    )
    .slice(0, 3000);
}

function getPayloadRoot(body) {
  // Support both the confirmed direct payload and a data wrapper.
  if (
    body.data &&
    typeof body.data === "object" &&
    !Array.isArray(body.data)
  ) {
    return body.data;
  }

  return body;
}

function buildLead(body) {
  const root = getPayloadRoot(body);

  const contact = root.contact || body.contact || {};
  const whatsapp = root.whatsapp || body.whatsapp || {};
  const whatsappText = whatsapp.text || {};

  // Confirmed Gallabox payload: whatsapp.from
  const rawPhone = cleanString(whatsapp.from);

  if (!rawPhone) {
    console.error("GALLABOX_PHONE_FIELD_DIAGNOSTIC", {
      rootKeys: Object.keys(root),
      bodyKeys: Object.keys(body),
      whatsappKeys: Object.keys(whatsapp),
      contactKeys: Object.keys(contact),
      hasDataWrapper: Boolean(body.data),
    });

    return { error: "missing_phone" };
  }

  // Do not use fromBSUID as a phone number; it may be a different ID.
  const phone = rawPhone.replace(/[^\d+]/g, "");

  if (phone.replace(/\D/g, "").length < 8) {
    return { error: "invalid_phone" };
  }

  const name =
    cleanString(contact.name) ||
    cleanString(root.name) ||
    "WhatsApp enquiry";

  const email =
    cleanString(contact.email) ||
    cleanString(root.email) ||
    cleanString(body.email);

  const message =
    cleanString(whatsappText.body) ||
    cleanString(root.message) ||
    "";

  const conversationId = cleanString(
    root.conversationId || body.conversationId
  );

  const contactId = cleanString(
    root.contactId ||
    contact.id ||
    body.contactId
  );

  const eventId = cleanString(
    root.id ||
    root.localMessageId ||
    body.id ||
    body.localMessageId
  );

  const notes = [
    "HIGH PRIORITY LEAD - GALLABOX WHATSAPP",
    "Source: Gallabox WhatsApp",
    `Customer message: ${message || "No text message supplied"}`,
  ].join("\n");

  // Preserve the Zyro endpoint and payload structure used previously.
const payload = {
  name,
  phone,
  ...(email ? { email } : {}),
  campaign: "gallabox_whatsapp_high_priority",
  notes,
};

  return {
    payload,
    eventId,
    conversationId,
    contactId,
  };
}

export default async function handler(req, res) {
  // Only accept POST requests.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "method_not_allowed",
    });
  }

  // Authenticate Gallabox's webhook request.
  const expectedSecret = process.env.GALLABOX_WEBHOOK_SECRET;

  const suppliedSecret =
    getHeader(req, "x-webhook-secret") ||
    cleanString(req.query?.secret);

  if (
    !expectedSecret ||
    !suppliedSecret ||
    suppliedSecret !== expectedSecret
  ) {
    return res.status(401).json({
      error: "unauthorized",
    });
  }

  // Validate Zyro configuration.
  const zyroBaseUrl = process.env.ZYRO_BASE_URL;
  const zyroApiKey = process.env.ZYRO_API_KEY;

  if (!zyroBaseUrl || !zyroApiKey) {
    console.error("GALLABOX_CONFIG_ERROR", {
      hasZyroBaseUrl: Boolean(zyroBaseUrl),
      hasZyroApiKey: Boolean(zyroApiKey),
    });

    return res.status(500).json({
      error: "server_misconfigured",
    });
  }

  let body = req.body;

  // Some deployments or clients may send a JSON string.
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({
        error: "invalid_json",
      });
    }
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return res.status(400).json({
      error: "invalid_payload",
    });
  }

  const lead = buildLead(body);

  if (lead.error) {
    console.error("GALLABOX_PAYLOAD_VALIDATION_FAILED", {
      error: lead.error,
    });

    return res.status(422).json({
      error: lead.error,
      message:
        lead.error === "missing_phone"
          ? "Expected phone at whatsapp.from."
          : "The phone number is invalid.",
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

    let zyroResult = {};

    try {
      zyroResult = responseText
        ? JSON.parse(responseText)
        : {};
    } catch {
      // A non-JSON response is allowed; retain it for diagnostics.
      zyroResult = {};
    }

    if (zyroResponse.ok) {
      console.log("GALLABOX_ZYRO_LEAD_CREATED", {
        status: zyroResponse.status,
        eventIdPresent: Boolean(lead.eventId),
      });

      return res.status(200).json({
        ok: true,
        source: "gallabox_whatsapp",
        priority_label: "high",
        zyro_status: zyroResponse.status,
        lead_id:
          zyroResult.id ||
          zyroResult.leadId ||
          null,
      });
    }

    // Log Zyro's validation response to diagnose HTTP 422.
    // Never log the API key or the submitted lead payload.
    console.error("ZYRO_LEAD_REJECTION", {
      status: zyroResponse.status,
      response: redactSensitiveData(responseText),
      eventIdPresent: Boolean(lead.eventId),
    });

    return res.status(502).json({
      error: "zyro_lead_creation_failed",
      zyro_status: zyroResponse.status,
    });
  } catch (error) {
    console.error("GALLABOX_ZYRO_REQUEST_FAILED", {
      message: error?.message || "unknown_error",
    });

    return res.status(502).json({
      error: "zyro_request_failed",
    });
  }
}
