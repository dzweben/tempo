import { NextRequest, NextResponse } from "next/server";

// MIGRATION PROBE — answers one question empirically: can Vercel's
// egress reach the institution's REDCap API at all? fetch-data.mjs:5 claims
// "the institution's survey database blocks Vercel IPs"; the whole shape of the Vercel
// migration forks on whether that is (still) true. The probe makes the
// cheapest authenticated call REDCap has (content=version) and reports
// ONLY reachability metadata — no study data touches this route.
//
// Auth: same shared secret as the EMA sender.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.SWEEP_SECRET || "";
  const given = req.headers.get("x-sweep-secret") || req.nextUrl.searchParams.get("secret") || "";
  const bearerOk = req.headers.get("authorization") === `Bearer ${secret}`;
  if (!secret || (given !== secret && !bearerOk)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = process.env.REDCAP_API_URL || "https://YOUR-INSTITUTION.edu/redcap/api/";
  const token = process.env.REDCAP_API_TOKEN || "";
  const started = Date.now();
  const result: Record<string, unknown> = { url, tokenPresent: Boolean(token) };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, content: "version", format: "json" }),
      signal: AbortSignal.timeout(25_000),
    });
    const body = (await res.text()).slice(0, 60);
    result.reachable = true;
    result.status = res.status;
    result.latencyMs = Date.now() - started;
    // 2xx + a version string = fully working. 403 with a REDCap error
    // body = network path open, token/ACL issue. TCP-level failure lands
    // in the catch below = egress genuinely blocked.
    result.bodyPreview = body;
  } catch (e) {
    result.reachable = false;
    result.latencyMs = Date.now() - started;
    result.error = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e).slice(0, 200);
  }
  console.log(`redcap-probe: ${JSON.stringify(result)}`);
  return NextResponse.json(result);
}
