// 256 % 32 === 0, so `byte % 32` below is unbiased.
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Generate a license key like `dvops_<32 chars of base32>`. */
export function generateLicenseKey(productId: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let random = "";
  for (const byte of bytes) {
    random += BASE32_ALPHABET[byte % 32];
  }
  return `${productId}_${random}`;
}

/** Constant-time string comparison (for signature checks). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
