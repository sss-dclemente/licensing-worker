import type { Env } from "./env";
import { json } from "./http";

const RATE_LIMIT = 60; // requests per window per IP
const WINDOW_MS = 60_000;

// Fixed-window rate limiting, in-memory per isolate. Best-effort BY DESIGN
// (YAGNI): a determined client hitting many isolates/colos gets more than
// 60 req/min, but that's fine for abuse damping — no KV/DO until it hurts.
const hitsByIp = new Map<string, { window: number; count: number }>();

/** Returns null if allowed, otherwise seconds to wait (Retry-After). */
function rateLimit(ip: string, now: number): number | null {
  const window = Math.floor(now / WINDOW_MS);
  const entry = hitsByIp.get(ip);
  if (!entry || entry.window !== window) {
    // New window also serves as cleanup for this IP's stale entry.
    hitsByIp.set(ip, { window, count: 1 });
    return null;
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT) {
    return Math.max(1, Math.ceil(((window + 1) * WINDOW_MS - now) / 1000));
  }
  return null;
}

interface LicenseRow {
  org_id: string | null;
  tier: string;
  status: string;
  expires_at: string | null;
}

const CACHE_HEADERS = { "Cache-Control": "public, max-age=3600" };

export async function handleValidate(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const retryAfter = rateLimit(ip, Date.now());
  if (retryAfter !== null) {
    return json({ error: "rate_limited" }, 429, { "Retry-After": String(retryAfter) });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const { licenseKey, productId, orgId } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof licenseKey !== "string" ||
    typeof productId !== "string" ||
    (orgId !== undefined && typeof orgId !== "string")
  ) {
    return json({ error: "invalid_body" }, 400);
  }

  const row = await env.DB
    .prepare("SELECT org_id, tier, status, expires_at FROM licenses WHERE key = ?1 AND product_id = ?2")
    .bind(licenseKey, productId)
    .first<LicenseRow>();

  if (!row) {
    // Cache-friendly negative: unknown keys are a 200, not an error.
    return json({ valid: false, tier: null, expiresAt: null }, 200, CACHE_HEADERS);
  }

  if (row.org_id === null && typeof orgId === "string") {
    // First activation locks the license to this org hash.
    await env.DB
      .prepare("UPDATE licenses SET org_id = ?1 WHERE key = ?2")
      .bind(orgId, licenseKey)
      .run();
  } else if (row.org_id !== null && typeof orgId === "string" && row.org_id !== orgId) {
    return json(
      { valid: false, tier: null, expiresAt: null, reason: "org_mismatch" },
      200,
      CACHE_HEADERS,
    );
  }

  const valid =
    row.status === "active" &&
    (row.expires_at === null || Date.parse(row.expires_at) > Date.now());

  return json({ valid, tier: row.tier, expiresAt: row.expires_at }, 200, CACHE_HEADERS);
}
