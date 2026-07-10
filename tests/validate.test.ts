import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { dispatch, seedLicense, validateRequest } from "./helpers";

describe("POST /v1/validate", () => {
  it("returns valid=true with tier and cache header for an active license", async () => {
    await seedLicense({ key: "dvops_activekey", tier: "pro" });
    const res = await dispatch(
      validateRequest({ licenseKey: "dvops_activekey", productId: "dvops" }, "203.0.113.10"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(await res.json()).toEqual({ valid: true, tier: "pro", expiresAt: null });
  });

  it("returns valid=false for an expired license", async () => {
    await seedLicense({ key: "dvops_expiredkey", expires_at: "2020-01-01T00:00:00.000Z" });
    const res = await dispatch(
      validateRequest({ licenseKey: "dvops_expiredkey", productId: "dvops" }, "203.0.113.11"),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ valid: boolean }>();
    expect(body.valid).toBe(false);
  });

  it("returns valid=false for a wrong product id", async () => {
    await seedLicense({ key: "dvops_wrongproduct", product_id: "dvops" });
    const res = await dispatch(
      validateRequest({ licenseKey: "dvops_wrongproduct", productId: "otherproduct" }, "203.0.113.12"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: false, tier: null, expiresAt: null });
  });

  it("returns 200 valid=false for an unknown key", async () => {
    const res = await dispatch(
      validateRequest({ licenseKey: "dvops_nosuchkey", productId: "dvops" }, "203.0.113.13"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(await res.json()).toEqual({ valid: false, tier: null, expiresAt: null });
  });

  it("returns 400 for a malformed body", async () => {
    const res = await dispatch(validateRequest({ licenseKey: 42 }, "203.0.113.14"));
    expect(res.status).toBe(400);

    const notJson = new Request("https://licensing.example.com/v1/validate", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.14" },
      body: "not json",
    });
    expect((await dispatch(notJson)).status).toBe(400);
  });

  it("binds org on first activation, accepts same org, rejects a different org", async () => {
    await seedLicense({ key: "dvops_orgbound" });

    const first = await dispatch(
      validateRequest({ licenseKey: "dvops_orgbound", productId: "dvops", orgId: "org-hash-a" }, "203.0.113.15"),
    );
    expect((await first.json<{ valid: boolean }>()).valid).toBe(true);
    const row = await env.DB
      .prepare("SELECT org_id FROM licenses WHERE key = ?1")
      .bind("dvops_orgbound")
      .first<{ org_id: string | null }>();
    expect(row?.org_id).toBe("org-hash-a");

    const same = await dispatch(
      validateRequest({ licenseKey: "dvops_orgbound", productId: "dvops", orgId: "org-hash-a" }, "203.0.113.15"),
    );
    expect((await same.json<{ valid: boolean }>()).valid).toBe(true);

    const other = await dispatch(
      validateRequest({ licenseKey: "dvops_orgbound", productId: "dvops", orgId: "org-hash-b" }, "203.0.113.15"),
    );
    const otherBody = await other.json<{ valid: boolean; reason?: string }>();
    expect(otherBody.valid).toBe(false);
    expect(otherBody.reason).toBe("org_mismatch");
  });

  it("rate limits an IP after 60 requests in a window", async () => {
    const ip = "198.51.100.99"; // dedicated IP: the limiter Map outlives per-test D1 isolation
    for (let i = 0; i < 60; i++) {
      const res = await dispatch(validateRequest({ licenseKey: "dvops_x", productId: "dvops" }, ip));
      expect(res.status).toBe(200);
    }
    const limited = await dispatch(validateRequest({ licenseKey: "dvops_x", productId: "dvops" }, ip));
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});
