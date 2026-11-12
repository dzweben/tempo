import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { maskRecipient } from "@/lib/mask";

export const dynamic = "force-dynamic";

async function readJsonOr(p: string, fallback: unknown[]) {
  try {
    return JSON.parse(await fs.readFile(p, "utf-8"));
  } catch {
    return fallback;
  }
}

export async function GET() {
  try {
    const dir = path.join(process.cwd(), "private", "data");
    // Two ledgers: the general sender's (STS/at-home/enable/payment) and
    // the EMA precision sender's. Normalize the EMA rows to the SentEntry
    // shape the dashboard expects and merge.
    const general = await readJsonOr(path.join(dir, "sent-log.json"), []);
    const ema = await readJsonOr(path.join(dir, "ema-sent-log.json"), []);
    const emaNormalized = (ema as Record<string, unknown>[]).map(e => ({
      id: e.key,
      sendKey: e.key,
      timestamp: e.at || e.sendAt,
      pid: e.pid,
      alertId: 64,
      instrument: `EMA prompt ${e.promptKey}${e.latencySec != null ? ` (+${e.latencySec}s)` : ""}`,
      kind: "ema_prompt",
      channel: e.channel || "sms",
      recipient: e.recipient || "-",
      status: e.status === "skipped_late" ? "skipped" : e.status,
      error: e.error || (e.status === "skipped_late" ? "over 30 min past slot — protocol skip" : undefined),
      dryRun: e.dryRun,
    }));
    // De-identified: recipients leave masked, and the sendKey (which embeds
    // the recipient) carries the masked form too.
    const rows = [...(general as Record<string, unknown>[]), ...emaNormalized].map(e => {
      const recipient = maskRecipient(e.channel, e.recipient);
      const sk = String(e.sendKey ?? "");
      const raw = String(e.recipient ?? "");
      return { ...e, recipient, sendKey: raw && raw !== "-" ? sk.split(raw).join(recipient) : sk };
    });
    return NextResponse.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to load sent log", details: msg }, { status: 500 });
  }
}
