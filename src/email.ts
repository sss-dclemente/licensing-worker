import type { Env } from "./env";

/**
 * Email a freshly issued license key via Resend. Best-effort: a missing
 * recipient or a Resend failure must never fail the webhook (Paddle would
 * retry and we would issue duplicate keys). Never log the key itself.
 */
export async function sendLicenseKeyEmail(
  env: Env,
  to: string | null,
  licenseKey: string,
  productId: string,
): Promise<void> {
  if (!to) {
    console.log(`no recipient email for ${productId} license; skipping delivery`);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "licenses@simplesmoothsafe.com",
        to,
        subject: `Your ${productId} license key`,
        text:
          `Thanks for your purchase.\n\n` +
          `Your license key:\n\n${licenseKey}\n\n` +
          `Setup: set the LICENSE_KEY environment variable to this key in your MCP server configuration.\n`,
      }),
    });
    if (!res.ok) {
      console.log(`license email send failed with status ${res.status}`);
    }
  } catch {
    console.log("license email send failed");
  }
}
