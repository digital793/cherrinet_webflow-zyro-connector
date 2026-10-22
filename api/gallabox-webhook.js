
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
 * Gallabox webhook URL:
 *   https://YOUR-DOMAIN/api/gallabox-webhook?secret=YOUR_SECRET
 *
 * IMPORTANT:
 * - Confirm Zyro's accepted payload fields and success status.
 * - This labels leads as high priority in campaign/notes.
 * - It does not set a native Zyro priority field unless Zyro supports it.
 */

const processedEvents = new Map();
const MAX_CACHE_SIZE = 5000;
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;

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

function isDuplicate(eventId) {
  if (!eventId) return false;

  const now = Date.now();

  for (const [id, timestamp] of processedEvents) {
    if (now - timestamp > EVENT_TTL_MS) {
      processedEvents.delete(id);
    }
  }

  if (processedEvents.has(eventId)) {
    return true;
  }

  // Prevent unbounded memory growth in the serverless instance.
  if (processedEvents.size >= MAX_CACHE_SIZE) {
    const oldestId = processedEvents.keys().next().value;
    if (oldestId) processedEvents.delete(oldestId);
  }

  processedEvents.set(eventId, now);
  return false;
}

function getSafeEventId(body) {
  return cleanString(
    body.id ||
    body.localMessageId ||
    ""
  );
}

function buildLead(body) {
  // Field paths confirmed from the actual Gallabox webhook schema.
  const contact = body.contact || {};
  const whatsapp = body.whatsapp || {};
  const whatsappText = whatsapp.text || {};

  const name =
    cleanString(contact.name) ||
    cleanString(body.name) ||
    "WhatsApp enquiry";

  const rawPhone =
    cleanString(whatsapp.from) ||
    cleanString(contact.phone) ||
    cleanString(contact.phoneNumber) ||
    cleanString(body.phone) ||
    cleanString(body.phoneNumber);

  if (!rawPhone) {
    return {
      error: "missing_phone",
    };
  }

  // Preserve digits and a possible international + prefix.
  const phone = rawPhone.replace(/[^\d+]/g, "");

  if (phone.replace(/\D/g, "").length < 8) {
    return {
      error: "invalid_phone",
    };
  }

  const email =
    cleanString(contact.email) ||
    cleanString(body.email);

  const message =
    cleanString(whatsappText.body) ||
    cleanString(body.message) ||
    "";

  const conversationId =
    cleanString(body.conversationId);

  const contactId =
    cleanString(body.contactId) ||
    cleanString(contact.id);

  const eventId = getSafeEventId(body);

  const notes = [
    "HIGH PRIORITY LEAD - GALLABOX WHATSAPP",
    "Source: Gallabox WhatsApp",
    `Conversation ID: ${conversationId || "Not supplied"}`,
    `Contact ID: ${contactId || "Not supplied"}`,
    `Message ID: ${eventId || "Not supplied"}`,
    `Customer message: ${message || "No text message supplied"}`,
  ].join("\n");

  const payload = {
    name,
    phone,
    ...(email ? { email } : {}),
    source: "whatsapp",
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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "method_not_allowed",
    });
  }

  // Authenticate the incoming webhook.
  const expectedSecret =
    process.env.GALLABOX_WEBHOOK_SECRET;

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

  const zyroBaseUrl =
    process.env.ZYRO_BASE_URL;

  const zyroApiKey =
    process.env.ZYRO_API_KEY;

  if (!zyroBaseUrl || !zyroApiKey) {
    console.error(
      "Gallabox integration: missing Zyro environment variables"
    );

    return res.status(500).json({
      error: "server_misconfigured",
    });
  }

  const body = req.body;

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return res.status(400).json({
      error: "invalid_payload",
    });
  }

  // Ignore non-inbound message events if the webhook is configured
  // to send more than Message.Received.
  const senderType = cleanString(body.senderType);

  if (
    senderType &&
    !["contact", "customer", "user"].includes(
      senderType.toLowerCase()
    )
  ) {
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: "not_an_inbound_customer_message",
    });
  }

  const lead = buildLead(body);

  if (lead.error) {
    // Never log customer message content or personal information.
    console.error(
      "Gallabox webhook payload validation failed:",
      lead.error
    );

    return res.status(422).json({
      error: lead.error,
      message:
        lead.error === "missing_phone"
          ? "No supported phone field was found."
          : "The supplied phone number is invalid.",
    });
  }

  /*
   * NOTE ON DUPLICATES:
   * This in-memory check only works within the same warm serverless
   * instance. It is NOT reliable across Vercel instances or cold starts.
   * Use a shared database with a unique event-ID constraint for
   * production-grade idempotency.
   */

  if (lead.eventId && isDuplicate(lead.eventId)) {
    return res.status(200).json({
      ok: true,
      duplicate: true,
      message: "Event already processed in this instance.",
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
      // Zyro may return a non-JSON response.
      zyroResult = {};
    }

    // Treat all 2xx responses as HTTP success.
    if (zyroResponse.ok) {
      console.log("Gallabox lead accepted by Zyro", {
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

    // Don't expose Zyro's response body or credentials to Gallabox.
    console.error("Zyro lead creation failed", {
      status: zyroResponse.status,
      eventIdPresent: Boolean(lead.eventId),
    });

    return res.status(502).json({
      error: "zyro_lead_creation_failed",
      zyro_status: zyroResponse.status,
    });
  } catch (error) {
    console.error("Gallabox -> Zyro request failed", {
      message: error?.message || "unknown_error",
    });

    return res.status(502).json({
      error: "zyro_request_failed",
    });
  }
}
