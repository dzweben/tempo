import { NextResponse } from "next/server";
import { verifyPassword, signCookie, AUTH_COOKIE_NAME, AUTH_COOKIE_MAX_AGE } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Naive in-memory rate limit. Per-process, so it resets on cold starts.
// Good enough to slow down brute force on a low-traffic dashboard.
const attempts: Record<string, { count: number; firstAttempt: number }> = {};
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function getClientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || "unknown";
}

export async function POST(request: Request) {
  const ip = getClientIp(request);

  // Rate limit check
  const now = Date.now();
  const record = attempts[ip];
  if (record) {
    if (now - record.firstAttempt > WINDOW_MS) {
      delete attempts[ip]; // window expired
    } else if (record.count >= MAX_ATTEMPTS) {
      const waitMin = Math.ceil((record.firstAttempt + WINDOW_MS - now) / 60000);
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${waitMin} minutes.` },
        { status: 429 }
      );
    }
  }

  let password: string;
  try {
    const body = await request.json();
    password = String(body.password || "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (!verifyPassword(password)) {
    attempts[ip] = attempts[ip]
      ? { count: attempts[ip].count + 1, firstAttempt: attempts[ip].firstAttempt }
      : { count: 1, firstAttempt: now };
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  // Success — issue signed cookie
  delete attempts[ip];
  const res = NextResponse.json({ success: true });
  res.cookies.set(AUTH_COOKIE_NAME, await signCookie(), {
    httpOnly: true,
    // Browsers reject `Secure` cookies over HTTP, which blocks login on
    // the local dev server (http://localhost:3100). Keep Secure on in
    // production (Vercel is always HTTPS).
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: AUTH_COOKIE_MAX_AGE,
    path: "/",
  });
  return res;
}
