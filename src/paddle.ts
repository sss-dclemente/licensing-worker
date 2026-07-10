import { sendLicenseKeyEmail } from "./email";
import type { Env } from "./env";
import { json } from "./http";
import { constantTimeEqual, generateLicenseKey } from "./keys";

const MAX_TIMESTAMP_SKEW_SECONDS = 300;

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Header format: `Paddle-Signature: ts=<unix seconds>;h1=<hex hmac>`. */
async function verifySignature(request: Request, rawBody: string, secret: string): Promise<boolean> {
  const header = request.headers.get("Paddle-Signature");
  if (!header) return false;
  const parts = new Map<string, string>();
  for (const piece of header.split(";")) {
    const eq = piece.indexOf("=");
    if (eq > 0) parts.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  const ts = parts.get("ts");
  const h1 = parts.get("h1");
  if (!ts || !h1) return false;
  const tsSeconds = Number(ts);
  if (!Number.isFinite(tsSeconds)) return false;
  if (Math.abs(Date.now() / 1000 - tsSeconds) > MAX_TIMESTAMP_SKEW_SECONDS) return false;
  const expected = await hmacSha256Hex(secret, `${ts}:${rawBody}`);
  return constantTimeEqual(expected, h1.toLowerCase());
}

const STATUS_MAP: Record<string, string> = {
  active: "active",
  trialing: "active",
  canceled: "canceled",
  past_due: "past_due",
};

interface ExtractedSubscription {
  subscriptionId: string;
  status: string;
  productId: string;
  tier: string;
  email: string | null;
  expiresAt: string | null;
}

function extractSubscription(event: Record<string, unknown>): ExtractedSubscription | null {
  const data = (event["data"] ?? {}) as Record<string, unknown>;
  if (typeof data["id"] !== "string") return null;
  const custom = (data["custom_data"] ?? {}) as Record<string, unknown>;
  const rawStatus = typeof data["status"] === "string" ? data["status"] : "canceled";
  const billingPeriod = (data["current_billing_period"] ?? {}) as Record<string, unknown>;
  const expiresAt =
    (typeof billingPeriod["ends_at"] === "string" ? billingPeriod["ends_at"] : null) ??
    (typeof data["next_billed_at"] === "string" ? data["next_billed_at"] : null);
  return {
    subscriptionId: data["id"],
    status: STATUS_MAP[rawStatus] ?? rawStatus,
    productId: typeof custom["product_id"] === "string" ? custom["product_id"] : "dvops",
    tier: typeof custom["tier"] === "string" ? custom["tier"] : "pro",
    email:
      (typeof custom["email"] === "string" ? custom["email"] : null) ??
      (typeof data["customer_email"] === "string" ? data["customer_email"] : null),
    expiresAt,
  };
}

async function createLicense(env: Env, sub: ExtractedSubscription): Promise<void> {
  const licenseKey = generateLicenseKey(sub.productId);
  await env.DB
    .prepare(
      "INSERT INTO licenses (key, product_id, org_id, tier, status, paddle_subscription_id, created_at, expires_at) " +
        "VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(
      licenseKey,
      sub.productId,
      sub.tier,
      sub.status,
      sub.subscriptionId,
      new Date().toISOString(),
      sub.expiresAt,
    )
    .run();
  await sendLicenseKeyEmail(env, sub.email, licenseKey, sub.productId);
}

export async function handlePaddleWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  if (!(await verifySignature(request, rawBody, env.PADDLE_WEBHOOK_SECRET))) {
    return json({ error: "invalid_signature" }, 401);
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const eventId = typeof event["event_id"] === "string" ? event["event_id"] : null;
  const eventType = typeof event["event_type"] === "string" ? event["event_type"] : "unknown";

  // Idempotency first: the UNIQUE event_id makes replays a no-op.
  const inserted = await env.DB
    .prepare(
      "INSERT OR IGNORE INTO events (event_id, event_type, payload, received_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(eventId, eventType, rawBody, new Date().toISOString())
    .run();
  if (inserted.meta.changes === 0) {
    return json({ replay: true }, 200);
  }

  const sub = extractSubscription(event);
  if (sub) {
    if (eventType === "subscription.created") {
      await createLicense(env, sub);
    } else if (eventType === "subscription.updated" || eventType === "subscription.canceled") {
      const updated = await env.DB
        .prepare("UPDATE licenses SET status = ?1, expires_at = ?2 WHERE paddle_subscription_id = ?3")
        .bind(sub.status, sub.expiresAt, sub.subscriptionId)
        .run();
      // Upsert: an `updated` for a subscription we never saw creates the license.
      if (updated.meta.changes === 0 && eventType === "subscription.updated") {
        await createLicense(env, sub);
      }
    }
  }

  return json({ ok: true }, 200);
}
