import { NextResponse, type NextRequest } from "next/server";
import { verifyCookie, AUTH_COOKIE_NAME } from "@/lib/auth";

// Routes that are ALWAYS accessible without auth.
const PUBLIC_PATHS = [
  "/login",
  "/api/login",
  "/api/logout",
  "/favicon.ico",
  "/_next", // Next.js assets
  // EMA sweeper: machine-to-machine backstop with its own shared-secret
  // auth (x-sweep-secret) — its callers (GitHub workflow, launchd) have
  // no login cookie. The route itself 401s without the secret.
  "/api/ema-sweep",
  // Migration probe: same shared-secret auth, no data exposure.
  "/api/redcap-probe",
  // Phase 2 refresh runner: same shared-secret auth.
  "/api/refresh",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (await verifyCookie(cookie)) {
    return NextResponse.next();
  }

  // Unauthenticated — for API routes return 401, for pages redirect to /login
  if (pathname.startsWith("/api/")) {
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

// Match everything except static files. Middleware runs on every matched request.
export const config = {
  matcher: [
    // Run on everything except Next.js internals, static files, and common image extensions
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js)).*)",
  ],
};
