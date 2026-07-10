import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";

import { dispatch, paddleSign, subscriptionEvent, validateRequest, webhookRequest } from "./helpers";

// Stub the worker's outbound fetch so Resend is never actually called.
// (fetchMock was removed from @cloudflare/vitest-pool-workers in the
// vitest-4-era releases; vi.stubGlobal is the supported simple alternative.)
let emailCalls: { to: unknown; hasKeyInText: boolean }[] = [];

beforeAll(() => {
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    if (url === "https://api.resend.com/emails") {
      const payload = JSON.parse(String(init?.body)) as { to: unknown; text: string };
      emailCalls.push({ to: payload.to, hasKeyInText: /_[a-z2-7]{32}/.test(payload.text) });
      return new Response(JSON.stringify({ id: "email_test" }), { status: 200 });
    }
    throw new Error(`unexpected outbound fetch in test: ${url}`);
  }) as typeof fetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function licenseRows(): Promise<{ key: string; status: string }[]> {
  const { results } = await env.DB
    .prepare("SELECT key, status FROM licenses ORDER BY created_at")
    .all<{ key: string; status: string }>();
  return results;
}

describe("Paddle webhook signature verification", () => {
  const body = JSON.stringify(subscriptionEvent("subscription.created"));

  it("rejects a missing Paddle-Signature header with 401", async () => {
    const res = await dispatch(await webhookRequest(body, { omitHeader: true }));
    expect(res.status).toBe(401);
  });

  it("rejects a tampered body with 401", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const h1 = await paddleSign(body, ts, "test-paddle-secret");
    const tampered = body.replace("subscription.created", "subscription.canceled");
    const res = await dispatch(await webhookRequest(tampered, { ts, h1 }));
    expect(res.status).toBe(401);
  });

  it("rejects a signature made with the wrong secret with 401", async () => {
    const res = await dispatch(await webhookRequest(body, { secret: "wrong-secret" }));
    expect(res.status).toBe(401);
  });

  it("rejects a stale timestamp with 401", async () => {
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    const res = await dispatch(await webhookRequest(body, { ts: staleTs }));
    expect(res.status).toBe(401);
  });

  it("accepts a valid signature", async () => {
    const res = await dispatch(await webhookRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("Paddle webhook event handling", () => {
  it("subscription.created inserts a prefixed license, logs the event, and emails the key", async () => {
    const emailsBefore = emailCalls.length;
    const event = subscriptionEvent("subscription.created", { eventId: "evt_created_1" });
    const res = await dispatch(await webhookRequest(JSON.stringify(event)));
    expect(res.status).toBe(200);

    const rows = await licenseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toMatch(/^dvops_[a-z2-7]{32}$/);
    expect(rows[0]?.status).toBe("active");

    const logged = await env.DB
      .prepare("SELECT event_type FROM events WHERE event_id = ?1")
      .bind("evt_created_1")
      .first<{ event_type: string }>();
    expect(logged?.event_type).toBe("subscription.created");

    expect(emailCalls.length).toBe(emailsBefore + 1);
    expect(emailCalls.at(-1)).toEqual({ to: "buyer@example.com", hasKeyInText: true });
  });

  it("replaying the same event_id is a no-op: 200 {replay:true}, no new license, no email", async () => {
    const emailsBefore = emailCalls.length;
    const event = subscriptionEvent("subscription.created", { eventId: "evt_replay_1" });
    const rawBody = JSON.stringify(event);

    const first = await dispatch(await webhookRequest(rawBody));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    const replay = await dispatch(await webhookRequest(rawBody));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ replay: true });

    expect(await licenseRows()).toHaveLength(1);
    expect(emailCalls.length).toBe(emailsBefore + 1);
  });

  it("subscription.canceled flips status so validate returns false", async () => {
    const created = subscriptionEvent("subscription.created", { subscriptionId: "sub_cancelme" });
    await dispatch(await webhookRequest(JSON.stringify(created)));
    const [license] = await licenseRows();
    expect(license).toBeDefined();

    const activeRes = await dispatch(
      validateRequest({ licenseKey: license!.key, productId: "dvops" }, "203.0.113.20"),
    );
    expect((await activeRes.json<{ valid: boolean }>()).valid).toBe(true);

    const canceled = subscriptionEvent("subscription.canceled", {
      subscriptionId: "sub_cancelme",
      status: "canceled",
      endsAt: null,
    });
    const cancelRes = await dispatch(await webhookRequest(JSON.stringify(canceled)));
    expect(cancelRes.status).toBe(200);

    const afterRes = await dispatch(
      validateRequest({ licenseKey: license!.key, productId: "dvops" }, "203.0.113.20"),
    );
    expect((await afterRes.json<{ valid: boolean }>()).valid).toBe(false);
  });

  it("subscription.updated for an unseen subscription upserts a license", async () => {
    const emailsBefore = emailCalls.length;
    const updated = subscriptionEvent("subscription.updated", { subscriptionId: "sub_unseen" });
    const res = await dispatch(await webhookRequest(JSON.stringify(updated)));
    expect(res.status).toBe(200);
    const rows = await licenseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
    expect(emailCalls.length).toBe(emailsBefore + 1);
  });
});
