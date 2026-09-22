"use client";

import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/tempo-utils";

// Daily Audit — the automated morning plumbing check. Each day gets a
// clickable report: what was planned, what actually sent, what failed
// or went unaccounted for, EMA delivery latency, and workflow health.

interface AuditIndexEntry {
  date: string;
  verdict: "GREEN" | "YELLOW" | "RED";
  problems: number;
  warnings: number;
  generatedAt: string;
}

interface AuditItem {
  pid: string;
  wave: number;
  kind: string;
  instrument: string;
  scheduledAt: string;
  channels: string[];
}

interface AuditReport {
  date: string;
  generatedAt: string;
  verdict: "GREEN" | "YELLOW" | "RED";
  problems: string[];
  warnings: string[];
  sendMode: string;
  dataFreshnessMin: number | null;
  planned: number;
  counts: Record<string, number>;
  detail: Record<string, AuditItem[]>;
  ema: { planned: number; sent: number; skippedLate: number; failed: number; unaccounted?: number; maxLatencySec: number | null; medianLatencySec: number | null };
  workflowRuns: Record<string, Record<string, number> | string>;
  totals: { participants: number; queueUpcoming: number; sentAllTime: number };
}

const VERDICT_STYLE: Record<string, string> = {
  GREEN: "bg-emerald-100 text-emerald-800 border-emerald-300",
  YELLOW: "bg-amber-100 text-amber-800 border-amber-300",
  RED: "bg-red-100 text-red-800 border-red-300",
};

const BUCKET_LABEL: Record<string, string> = {
  sent: "Sent",
  failed: "Failed",
  skipped: "Skipped (link/data)",
  completedBeforeSlot: "Completed before slot (no send needed)",
  postponed: "Postponed PIDs",
  slotStillOpen: "Slot still open (day-shift window)",
  unaccounted: "UNACCOUNTED — investigate",
};

export default function AuditPage() {
  const [index, setIndex] = useState<AuditIndexEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/data/audits").then(r => r.json()).then(d => {
      const idx = Array.isArray(d) ? d : [];
      setIndex(idx);
      if (idx.length > 0) setSelected(idx[0].date);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setReport(null);
    fetch(`/api/data/audits?date=${selected}`).then(r => r.json()).then(d => {
      if (d && d.date) setReport(d);
    });
  }, [selected]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Daily Audit</h2>
        <p className="text-sm text-gray-500 mt-1">
          Automated morning reconciliation — everything planned to send vs what actually happened,
          plus infrastructure health — then reviewed independently by an AI auditor that reads the
          evidence against the study&apos;s standing rules. Generated ~6:45 AM ET for the previous day.
        </p>
      </div>

      {loading ? <p className="text-gray-500 text-sm">Loading…</p> : index.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">
          No audit reports yet — the first one lands tomorrow at ~6:45 AM (or run the Daily Server
          Audit workflow manually).
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          {/* Day list */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden self-start">
            <ul className="divide-y divide-gray-100 max-h-[70vh] overflow-y-auto">
              {index.map(e => (
                <li key={e.date}>
                  <button
                    onClick={() => setSelected(e.date)}
                    className={`w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-2 ${selected === e.date ? "bg-indigo-50/60" : ""}`}
                  >
                    <span className={`inline-flex w-2.5 h-2.5 rounded-full shrink-0 ${e.verdict === "GREEN" ? "bg-emerald-500" : e.verdict === "YELLOW" ? "bg-amber-500" : "bg-red-500"}`} />
                    <span className="font-mono text-sm font-medium">{e.date}</span>
                    {e.problems > 0 && <span className="ml-auto text-xs font-semibold text-red-600">{e.problems}!</span>}
                    {e.problems === 0 && e.warnings > 0 && <span className="ml-auto text-xs font-semibold text-amber-600">{e.warnings}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Report detail */}
          <div className="lg:col-span-3 space-y-4">
            {!report ? <p className="text-gray-400 text-sm">Loading report…</p> : (
              <>
                <div className={`rounded-xl border px-5 py-4 ${VERDICT_STYLE[report.verdict]}`}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <p className="text-lg font-bold">{report.verdict === "GREEN" ? "✓ All clear" : report.verdict === "YELLOW" ? "⚠ Attention" : "✗ Problems found"} — {report.date}</p>
                    <p className="text-xs opacity-70">generated {formatDateTime(report.generatedAt)} · sending: {report.sendMode}</p>
                  </div>
                  {report.problems.map((p, i) => <p key={i} className="text-sm font-semibold mt-1">• {p}</p>)}
                  {report.warnings.map((w, i) => <p key={i} className="text-sm mt-1 opacity-80">• {w}</p>)}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Stat label="Planned sends" value={report.planned} />
                  <Stat label="Sent" value={report.counts.sent ?? 0} good />
                  <Stat label="Failed" value={report.counts.failed ?? 0} bad={(report.counts.failed ?? 0) > 0} />
                  <Stat label="Unaccounted" value={report.counts.unaccounted ?? 0} bad={(report.counts.unaccounted ?? 0) > 0} />
                </div>

                {/* EMA prompt precision */}
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <h3 className="text-sm font-semibold text-gray-900 mb-2">EMA prompts</h3>
                  {report.ema.planned === 0 ? (
                    <p className="text-sm text-gray-400">None scheduled this day.</p>
                  ) : (
                    <p className="text-sm text-gray-700">
                      {report.ema.sent}/{report.ema.planned} delivered
                      {report.ema.medianLatencySec != null && <> · median {report.ema.medianLatencySec}s after slot · worst {report.ema.maxLatencySec}s</>}
                      {report.ema.skippedLate > 0 && <span className="text-amber-700"> · {report.ema.skippedLate} protocol-skipped (late)</span>}
                      {report.ema.failed > 0 && <span className="text-red-700"> · {report.ema.failed} failed</span>}
                      {(report.ema.unaccounted ?? 0) > 0 && <span className="text-red-700 font-semibold"> · {report.ema.unaccounted} UNACCOUNTED</span>}
                    </p>
                  )}
                </div>

                {/* Buckets */}
                {Object.entries(report.detail).filter(([, items]) => items.length > 0).map(([bucket, items]) => (
                  <div key={bucket} className={`bg-white rounded-xl border overflow-hidden ${bucket === "unaccounted" ? "border-red-300" : "border-gray-200"}`}>
                    <div className={`px-4 py-2.5 border-b text-sm font-semibold ${bucket === "unaccounted" ? "bg-red-50 text-red-800 border-red-200" : "bg-gray-50 text-gray-700 border-gray-200"}`}>
                      {BUCKET_LABEL[bucket] || bucket} · {items.length}
                    </div>
                    <div className="overflow-x-auto max-h-72 overflow-y-auto">
                      <table className="w-full text-xs">
                        <tbody>
                          {items.map((it, i) => (
                            <tr key={i} className="border-b border-gray-50">
                              <td className="px-4 py-1.5 font-mono font-semibold">{it.pid}</td>
                              <td className="px-2 py-1.5 text-gray-500">W{it.wave}</td>
                              <td className="px-2 py-1.5">{it.instrument}</td>
                              <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">{formatDateTime(it.scheduledAt)}</td>
                              <td className="px-4 py-1.5 font-mono text-gray-500">{it.channels.join(", ") || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}

                {/* Workflow health */}
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <h3 className="text-sm font-semibold text-gray-900 mb-2">Automation runs this day</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                    {Object.entries(report.workflowRuns).map(([wf, c]) => (
                      <div key={wf} className="flex items-center justify-between gap-2 px-3 py-1.5 rounded bg-gray-50">
                        <span className="text-gray-700 truncate">{wf}</span>
                        {typeof c === "string" ? <span className="text-gray-400 text-xs">{c}</span> : (
                          <span className="font-mono text-xs shrink-0">
                            <span className="text-emerald-700">{c.success || 0}✓</span>
                            {(c.failure || 0) > 0 && <span className="text-red-600"> {c.failure}✗</span>}
                            {(c.cancelled || 0) > 0 && <span className="text-gray-500"> {c.cancelled}∅</span>}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, good, bad }: { label: string; value: number; good?: boolean; bad?: boolean }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 tabular-nums ${bad ? "text-red-600" : good ? "text-emerald-600" : "text-gray-900"}`}>{value}</p>
    </div>
  );
}
