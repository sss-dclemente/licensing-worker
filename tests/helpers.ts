import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import worker from "../src/index";

export async function dispatch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    // Plain `new Request()` lacks the incoming-request cf properties; the
    // worker never reads request.cf, so the cast is safe.
    request as Parameters<typeof worker.fetch>[0],
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

export function validateRequest(body: unknown, ip = "203.0.113.1"): Request {
  return new Request("https://licensing.example.com/v1/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}

export interface SeedLicense {
  key: string;
  product_id?: string;
  org_id?: string | null;
  tier?: string;
  status?: string;
  paddle_subscription_id?: string | null;
  expires_at?: string | null;
}

export async function seedLicense(license: SeedLicense): Promise<void> {
  await env.DB
    .prepare(
      "INSERT INTO licenses (key, product_id, org_id, tier, status, paddle_subscription_id, created_at, expires_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(
      license.key,
      license.product_id ?? "dvops",
      license.org_id ?? null,
      license.tier ?? "pro",
      license.status ?? "active",
      license.paddle_subscription_id ?? null,
      new Date().toISOString(),
      license.expires_at ?? null,
    )
    .run();
}

/**
 * Test-local HMAC signing (deliberately independent of src/paddle.ts) for
 * building Paddle-Signature headers.
 */
export async function paddleSign(rawBody: string, ts: number, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${ts}:${rawBody}`));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function webhookRequest(
  rawBody: string,
  options: { ts?: number; h1?: string; omitHeader?: boolean; secret?: string } = {},
): Promise<Request> {
  const ts = options.ts ?? Math.floor(Date.now() / 1000);
  const h1 = options.h1 ?? (await paddleSign(rawBody, ts, options.secret ?? "test-paddle-secret"));
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!options.omitHeader) headers["Paddle-Signature"] = `ts=${ts};h1=${h1}`;
  return new Request("https://licensing.example.com/v1/webhooks/paddle", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

export function subscriptionEvent(
  eventType: string,
  overrides: {
    eventId?: string;
    subscriptionId?: string;
    status?: string;
    endsAt?: string | null;
    customData?: Record<string, unknown> | undefined;
    customerEmail?: string;
  } = {},
): Record<string, unknown> {
  return {
    event_id: overrides.eventId ?? `evt_${crypto.randomUUID()}`,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    data: {
      id: overrides.subscriptionId ?? "sub_123",
      status: overrides.status ?? "active",
      customer_email: overrides.customerEmail ?? "buyer@example.com",
      custom_data: overrides.customData ?? { product_id: "dvops", tier: "pro", email: "buyer@example.com" },
      current_billing_period:
        overrides.endsAt === null ? undefined : { ends_at: overrides.endsAt ?? "2027-01-01T00:00:00.000Z" },
    },
  };
}
