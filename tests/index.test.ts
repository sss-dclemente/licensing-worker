import { describe, expect, it } from "vitest";

import { dispatch } from "./helpers";

describe("router", () => {
  it("GET /v1/health returns ok with a timestamp", async () => {
    const res = await dispatch(new Request("https://licensing.example.com/v1/health"));
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; ts: string }>();
    expect(body.ok).toBe(true);
    expect(Date.parse(body.ts)).not.toBeNaN();
  });

  it("unknown routes return 404 JSON", async () => {
    const res = await dispatch(new Request("https://licensing.example.com/nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
