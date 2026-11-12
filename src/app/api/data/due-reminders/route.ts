import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const p = path.join(process.cwd(), "private", "data", "due-reminders.json");
    const raw = await fs.readFile(p, "utf-8");
    return NextResponse.json(JSON.parse(raw));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) return NextResponse.json([]);
    return NextResponse.json({ error: "Failed to load due reminders", details: msg }, { status: 500 });
  }
}
