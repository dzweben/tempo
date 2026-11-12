import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// GET /api/data/audits           → index (list of daily reports)
// GET /api/data/audits?date=YYYY-MM-DD → one day's full report
export async function GET(req: NextRequest) {
  try {
    const dir = path.join(process.cwd(), "private", "data", "audits");
    const date = req.nextUrl.searchParams.get("date");
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return NextResponse.json({ error: "bad date" }, { status: 400 });
      }
      const raw = await fs.readFile(path.join(dir, `${date}.json`), "utf-8");
      return NextResponse.json(JSON.parse(raw));
    }
    const raw = await fs.readFile(path.join(dir, "index.json"), "utf-8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json([]);
  }
}
