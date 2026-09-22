"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDateTime } from "@/lib/tempo-utils";
import { useCohort, cohortMatches } from "@/lib/cohort";
import CohortFilter from "@/components/CohortFilter";

// Ledger of every message the sender actually fired (or skipped/failed),
// newest first. This is the idempotency log the send pipeline commits
// after each cycle — what you see here is exactly what participants got.

interface SentEntry {
  id: string;
  sendKey?: string;
  timestamp: string;
  pid: string;
  alertId: number;
  instrument: string;
  kind?: string;
  channel: string;
  recipient: string;
  status: "sent" | "failed" | "skipped";
  error?: string;
  dryRun?: boolean;
}

const STATUS_STYLE: Record<string, string> = {
  sent: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-700",
  skipped: "bg-amber-100 text-amber-800",
};

export default function SentLogPage() {
  const [entries, setEntries] = useState<SentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"all" | "sent" | "failed" | "skipped">("all");
  const [search, setSearch] = useState("");
  const [cohort] = useCohort();

  useEffect(() => {
    fetch("/api/data/sent-log").then(r => r.json()).then(d => {
      setEntries(Array.isArray(d) ? d : []);
    }).finally(() => setLoading(false));
  }, []);

  const rows = useMemo(() => {
    let xs = entries.filter(e => cohortMatches(e.pid, cohort));
    if (statusFilter !== "all") xs = xs.filter(e => e.status === statusFilter);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      xs = xs.filter(e =>
        e.pid.toLowerCase().includes(s) ||
        (e.instrument || "").toLowerCase().includes(s) ||
        (e.recipient || "").toLowerCase().includes(s)
      );
    }
    return xs.slice().sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  }, [entries, statusFilter, search, cohort]);

  // Headline counts are REAL sends only — a dry-run rehearsal writes log
  // rows too (its paper trail), and mixing them in here once made a
  // rehearsal look like a live blast.
  const counts = useMemo(() => {
    const c = { sent: 0, failed: 0, skipped: 0, dry: 0 };
    for (const e of entries) {
      if (e.dryRun) { c.dry++; continue; }
      if (e.status in c) c[e.status as keyof typeof c]++;
    }
    return c;
  }, [entries]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Sent Log</h2>
          <p className="text-sm text-gray-500 mt-1">
            Every message the automated sender fired — exactly what participants received, when, and
            on which channel. Failures and link-unresolved skips surface here for follow-up.
          </p>
        </div>
        <CohortFilter />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Sent (real)" value={counts.sent} accent="text-emerald-600" />
        <Stat label="Failed" value={counts.failed} accent="text-red-600" />
        <Stat label="Skipped (needs follow-up)" value={counts.skipped} accent="text-amber-600" />
        <Stat label="Rehearsal rows (nothing sent)" value={counts.dry} accent="text-sky-600" />
      </div>

      {counts.dry > 0 && counts.sent === 0 && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <strong>No real messages have been sent.</strong> The rows marked{" "}
          <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-100 text-sky-800 align-middle">REHEARSAL</span>{" "}
          below are from a dry run — the sender walked through every step (recipients, message text,
          survey links) and then deliberately did <em>not</em> transmit. They exist so you can review
          exactly what a real run will do.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
          {(["all", "sent", "failed", "skipped"] as const).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md capitalize ${
                statusFilter === s ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search PID, instrument, recipient…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-72 max-w-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <span className="text-sm text-gray-500 ml-auto">{rows.length} entries</span>
      </div>

      {loading ? <p className="text-gray-500 text-sm">Loading…</p> : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                  <th className="text-left px-4 py-3 font-semibold">When (ET)</th>
                  <th className="text-left px-4 py-3 font-semibold">PID</th>
                  <th className="text-left px-4 py-3 font-semibold">Message</th>
                  <th className="text-left px-4 py-3 font-semibold">Channel</th>
                  <th className="text-left px-4 py-3 font-semibold">Recipient</th>
                  <th className="text-left px-4 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="py-10 text-center text-gray-400">
                    {entries.length === 0 ? "No messages sent yet — the log fills as the sender fires." : "Nothing matches."}
                  </td></tr>
                )}
                {rows.slice(0, 500).map((e, i) => (
                  <tr key={`${e.sendKey || e.id}-${i}`} className={`border-b border-gray-100 hover:bg-gray-50 align-top ${e.dryRun ? "opacity-60" : ""}`}>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 whitespace-nowrap">{formatDateTime(e.timestamp)}</td>
                    <td className="px-4 py-2.5 font-mono font-semibold">{e.pid}</td>
                    <td className="px-4 py-2.5 text-gray-800">{e.instrument}
                      {e.dryRun && <span className="ml-2 inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-100 text-sky-800">REHEARSAL</span>}
                    </td>
                    <td className="px-4 py-2.5 uppercase text-xs font-semibold text-gray-500">{e.channel}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{e.recipient}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-semibold ${e.dryRun ? "bg-sky-100 text-sky-800" : (STATUS_STYLE[e.status] || "bg-gray-100 text-gray-600")}`}>
                        {e.dryRun ? "not sent (dry)" : e.status}
                      </span>
                      {e.error && <p className="text-xs text-red-600 mt-1 max-w-xs">{e.error}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 500 && (
            <p className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100">Showing newest 500 of {rows.length}.</p>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 tabular-nums ${accent}`}>{value}</p>
    </div>
  );
}
