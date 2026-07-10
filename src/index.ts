import type { Env } from "./env";
import { json } from "./http";
import { handlePaddleWebhook } from "./paddle";
import { handleValidate } from "./validate";

type Handler = (request: Request, env: Env) => Response | Promise<Response>;

function route(method: string, pathname: string): Handler | null {
  if (method === "GET" && pathname === "/v1/health") {
    return () => json({ ok: true, ts: new Date().toISOString() });
  }
  if (method === "POST" && pathname === "/v1/validate") return handleValidate;
  if (method === "POST" && pathname === "/v1/webhooks/paddle") return handlePaddleWebhook;
  return null;
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const handler = route(request.method, new URL(request.url).pathname);
    if (!handler) return json({ error: "not_found" }, 404);
    try {
      return await handler(request, env);
    } catch (err) {
      // Never include request bodies (license keys) or secrets in logs.
      console.error("unhandled error:", err instanceof Error ? err.message : String(err));
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
