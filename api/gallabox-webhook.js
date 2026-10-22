
/**
 * api/gallabox-webhook.js
 *
 * Gallabox WhatsApp -> Vercel -> Zyro lead API
 *
 * Environment variables:
 *   ZYRO_BASE_URL
 *   ZYRO_API_KEY
 *   GALLABOX_WEBHOOK_SECRET
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Protect the endpoint. Configure Gallabox with this secret in its
  // webhook URL if supported, or use the x-webhook-secret header.
  const expectedSecret = process.env.GALLABOX_WEBHOOK_SECRET;
  const suppliedSecret =
    req.headers["x-webhook-secret"] ||
    req.query?.secret;

  if (!expectedSecret || suppliedSecret !== expectedSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const ZYRO_BASE = process.env.ZYRO_BASE_URL;
  const ZYRO_KEY = process.env.ZYRO_API_KEY;

  if (!ZYRO_BASE || !ZYRO_KEY) {
    console.error("Gallabox integration: Zyro environment is missing");
    return res.status(500).json({ error: "server_misconfigured" });
  }

  try {
    const body = req.body;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "invalid_payload" });
    }

    // Search common names in the root and typical nested objects.
    // Verify these against Gallabox's actual webhook response.
    const objects = [
      body,
      body.data,
      body.contact,
      body.customer,
      body.message,
      body.conversation,
      body.data?.contact,
      body.data?.customer,
      body.data?.message,
      body.data?.conversation,
    ].filter((item) => item && typeof item === "object");

    function pick(...keys) {
      for (const obj of objects) {
        for (const key of keys) {
          const value = obj[key];
          if (
            value !== undefined &&
            value !== null &&
            typeof value !== "object" &&
            String(value).trim() !== ""
          ) {
            return String(value).trim();
          }
        }
      }
      return undefined;
    }

    const name = pick(
      "name", "contactName", "contact_name",
      "customerName", "customer_name", "fullName"
    );

    const rawPhone = pick(
      "phone", "phoneNumber", "phone_number",
      "mobile", "mobileNumber", "waId", "wa_id"
    );

    const email = pick("email", "emailAddress", "email_address");
    const message = pick("text", "body", "messageText", "message_text");
    const conversationId = pick(
      "conversationId", "conversation_id", "id"
    );
    const event = pick("event", "eventType", "event_type", "type");


if (!rawPhone) {
  // Log field names and data types, NOT customer data.
  function inspectShape(value, path = "body", depth = 0) {
    if (depth > 5 || value == null) return [];

    if (Array.isArray(value)) {
      return value.length
        ? inspectShape(value[0], `${path}[0]`, depth + 1)
        : [`${path}: empty array`];
    }

    if (typeof value !== "object") {
      return [`${path}: ${typeof value}`];
    }

    return Object.entries(value).flatMap(([key, child]) =>
      inspectShape(child, `${path}.${key}`, depth + 1)
    );
  }

  console.error("GALLABOX_PAYLOAD_SCHEMA", inspectShape(body));

  return res.status(422).json({
    error: "missing_phone",
    message: "Inspect Vercel logs for GALLABOX_PAYLOAD_SCHEMA.",
  });
}


    // Keep digits and an optional leading plus.
    const phone = rawPhone.replace(/[^\d+]/g, "");

    if (phone.replace(/\D/g, "").length < 8) {
      return res.status(422).json({ error: "invalid_phone" });
    }

    const notes = [
      "HIGH PRIORITY LEAD — GALLABOX WHATSAPP",
      `Event: ${event || "not supplied"}`,
      `Conversation ID: ${conversationId || "not supplied"}`,
      `Customer message: ${message || "not supplied in webhook"}`,
      "Source: Gallabox WhatsApp",
    ].join("\n");

    const payload = {
      name: name || "WhatsApp enquiry",
      phone,
      ...(email ? { email } : {}),
      source: "whatsapp",
      campaign: "gallabox_whatsapp_high_priority",
      notes,
    };

    const response = await fetch(
      `${ZYRO_BASE.replace(/\/+$/, "")}/api/v2/webhooks/leads`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZYRO_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const result = await response.json().catch(() => ({}));

    if (response.status === 201) {
      console.log("Gallabox lead created", {
        status: response.status,
        leadId: result.id || null,
      });

      return res.status(200).json({
        ok: true,
        lead_id: result.id || null,
        source: "gallabox_whatsapp",
        priority_label: "high",
      });
    }

    // Don't acknowledge a failed Zyro write as successful.
    console.error("Zyro rejected Gallabox lead", {
      status: response.status,
    });

    return res.status(502).json({
      error: "zyro_lead_creation_failed",
      zyro_status: response.status,
    });
  } catch (error) {
    console.error("Gallabox webhook processing failed", {
      message: error?.message || "unknown_error",
    });

    return res.status(500).json({ error: "internal_error" });
  }
}
