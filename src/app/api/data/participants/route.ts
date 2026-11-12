import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { maskName, maskEmail, maskPhone } from "@/lib/mask";

// Auth is enforced by middleware.ts — if we reach this handler, the caller has a valid cookie.
export const dynamic = "force-dynamic";

type P = { contact?: Record<string, unknown>; waves?: Record<string, { ema?: Record<string, unknown> }> };

// The dashboard is de-identified: names, emails and phones leave this
// route masked, so the browser never receives a real contact detail.
function deidentify(p: P): P {
  const c = p.contact || {};
  const waves = Object.fromEntries(Object.entries(p.waves || {}).map(([w, wave]) =>
    [w, wave?.ema ? { ...wave, ema: { ...wave.ema, phone: maskPhone(wave.ema.phone) } } : wave]));
  return {
    ...p,
    waves,
    contact: {
      ...c,
      firstName: maskName(c.firstName), lastName: maskName(c.lastName), parentName: maskName(c.parentName),
      email: maskEmail(c.email),
      phonePrimary: maskPhone(c.phonePrimary), phoneSecondary: maskPhone(c.phoneSecondary), childPhone: maskPhone(c.childPhone),
    },
  };
}

export async function GET() {
  try {
    const dataPath = path.join(process.cwd(), "private", "data", "participants.json");
    const data = JSON.parse(await fs.readFile(dataPath, "utf-8"));
    return NextResponse.json({ ...data, participants: (data.participants || []).map(deidentify) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to load participants", details: msg }, { status: 500 });
  }
}
