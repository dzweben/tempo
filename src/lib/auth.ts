// Simple password-gate auth for the TEMPO dashboard.
// Uses Web Crypto API so the code runs on both Node (API routes) and Edge (middleware).

const COOKIE_NAME = "tempo_auth";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getCookieSecret(): string {
  const s = process.env.COOKIE_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!s) throw new Error("DASHBOARD_PASSWORD or COOKIE_SECRET env var is required");
  return s;
}

function getPassword(): string {
  const p = process.env.DASHBOARD_PASSWORD;
  if (!p) throw new Error("DASHBOARD_PASSWORD env var is required");
  return p;
}

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

// Constant-time string comparison (avoids early-exit timing leak)
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function hmacSHA256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(sig);
}

export function verifyPassword(submitted: string): boolean {
  try {
    return safeEqual(submitted, getPassword());
  } catch {
    return false;
  }
}

// Create a signed cookie value: "issuedAt.signature"
export async function signCookie(): Promise<string> {
  const issuedAt = Date.now().toString();
  const sig = await hmacSHA256Hex(getCookieSecret(), issuedAt);
  return `${issuedAt}.${sig}`;
}

// Returns true only if the cookie is correctly signed AND not expired.
export async function verifyCookie(cookieValue: string | undefined | null): Promise<boolean> {
  if (!cookieValue) return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return false;
  const [issuedAt, sig] = parts;

  let expected: string;
  try {
    expected = await hmacSHA256Hex(getCookieSecret(), issuedAt);
  } catch {
    return false;
  }
  if (!safeEqual(sig, expected)) return false;

  const issued = parseInt(issuedAt, 10);
  if (isNaN(issued)) return false;
  const ageSeconds = (Date.now() - issued) / 1000;
  return ageSeconds >= 0 && ageSeconds < COOKIE_MAX_AGE_SECONDS;
}

export const AUTH_COOKIE_NAME = COOKIE_NAME;
export const AUTH_COOKIE_MAX_AGE = COOKIE_MAX_AGE_SECONDS;
