// De-identification for the dashboard: contacts are masked in the data
// API routes, so the browser never receives a real name, email, or phone.
//   name  "Jordan"              → "J***n"
//   email "a.person@example.org" → "a***n@e***e.org"
//   phone "(555) 010-0199"      → "5***9"

function maskToken(s: string): string {
  const t = s.trim();
  if (!t) return "";
  return t.length === 1 ? `${t}***` : `${t[0]}***${t[t.length - 1]}`;
}

export function maskName(s: unknown): string {
  return maskToken(String(s ?? ""));
}

export function maskEmail(s: unknown): string {
  const t = String(s ?? "").trim();
  const at = t.lastIndexOf("@");
  if (at < 1) return maskToken(t);
  const domain = t.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const label = dot > 0 ? domain.slice(0, dot) : domain;
  return `${maskToken(t.slice(0, at))}@${maskToken(label)}${dot > 0 ? domain.slice(dot) : ""}`;
}

export function maskPhone(s: unknown): string {
  let d = String(s ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return maskToken(d);
}

export function maskRecipient(channel: unknown, r: unknown): string {
  const v = String(r ?? "");
  if (!v || v === "-") return v;
  return channel === "email" || v.includes("@") ? maskEmail(v) : maskPhone(v);
}
