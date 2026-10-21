"use client";

import { useEffect, useState, useMemo } from "react";
import type { Participant, WaveYear } from "@/types";
import { WAVE_YEARS, WAVE_LABELS, computeStats, formatDateTime } from "@/lib/tempo-utils";
import { useCohort, cohortMatches } from "@/lib/cohort";
import CohortFilter from "@/components/CohortFilter";

interface LastFetch {
  ok: boolean;
  timestamp: string | null;
  counts?: { participants: number; dueNext7Days: number };
  error?: string;
}

export default function OverviewPage() {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [lastFetch, setLastFetch] = useState<LastFetch | null>(null);
  const [due, setDue] = useState<{ pid: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [pRes, lRes, dRes] = await Promise.all([
          fetch("/api/data/participants"),
          fetch("/api/data/last-fetch"),
          fetch("/api/data/due-reminders"),
        ]);
        const pj = await pRes.json();
        if (pRes.ok) setParticipants(pj.participants || []);
        if (lRes.ok) setLastFetch(await lRes.json());
        if (dRes.ok) {
          const arr = await dRes.json();
          setDue(Array.isArray(arr) ? arr : []);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const [cohort] = useCohort();
  const scoped = useMemo(() => participants.filter(p => cohortMatches(p.pid, cohort)), [participants, cohort]);
  const stats = useMemo(() => computeStats(scoped), [scoped]);
  const dueCount = useMemo(() => due.filter(d => cohortMatches(d.pid, cohort)).length, [due, cohort]);

  if (loading) return <Spinner label="Loading overview…" />;
  if (error) return <ErrorBox error={error} />;

  const isEmpty = scoped.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Overview</h2>
          <p className="text-sm text-gray-500 mt-1">
            Wave-by-wave participation, completion, and outgoing-message status.
          </p>
        </div>
        <CohortFilter />
      </div>

      {/* Fetch freshness banner */}
      <FetchBanner lastFetch={lastFetch} />

      {isEmpty ? (
        <EmptyState />
      ) : (
        <>
          {/* Marquee row */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <StatCard label="Total participants" value={stats.totalParticipants} accent="indigo" />
            <StatCard label="Due in next 7 days" value={dueCount} accent="amber" />
            <StatCard label="Active EMA cycles" value={Object.values(stats.emaActive).reduce((a, b) => a + b, 0)} accent="purple" />
            <StatCard label="V2 complete" value={Object.values(stats.v2Complete).reduce((a, b) => a + b, 0)} accent="emerald" />
          </div>

          {/* Visual completion panels */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <PromptHistogram participants={scoped} />
            <WaveProgress stats={stats} />
          </div>

          {/* Per-wave breakdown */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-base font-semibold text-gray-900">Per-wave completion</h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                  <th className="text-left px-4 py-3 font-semibold">Wave</th>
                  <th className="text-center px-4 py-3 font-semibold">Active</th>
                  <th className="text-center px-4 py-3 font-semibold">V1 done</th>
                  <th className="text-center px-4 py-3 font-semibold">At-home done</th>
                  <th className="text-center px-4 py-3 font-semibold">Cycles done</th>
                  <th className="text-center px-4 py-3 font-semibold">EMA done (≥10/25)</th>
                  <th className="text-center px-4 py-3 font-semibold">V2 done</th>
                </tr>
              </thead>
              <tbody>
                {WAVE_YEARS.map(w => (
                  <tr key={w} className="border-b border-gray-100">
                    <td className="px-4 py-3 font-mono font-medium text-gray-900">{WAVE_LABELS[w]}</td>
                    <td className="text-center px-4 py-3">{stats.byWave[w]}</td>
                    <td className="text-center px-4 py-3">
                      <Ratio numer={stats.v1Complete[w]} denom={stats.totalParticipants} />
                    </td>
                    <td className="text-center px-4 py-3">
                      <Ratio numer={stats.atHomeComplete[w]} denom={stats.totalParticipants} />
                    </td>
                    <td className="text-center px-4 py-3">
                      <Ratio numer={stats.stsComplete[w]} denom={stats.totalParticipants} />
                    </td>
                    <td className="text-center px-4 py-3">
                      <Ratio numer={stats.emaComplete[w]} denom={stats.totalParticipants} />
                    </td>
                    <td className="text-center px-4 py-3">
                      <Ratio numer={stats.v2Complete[w]} denom={stats.totalParticipants} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent: "indigo" | "amber" | "purple" | "emerald" }) {
  const accentMap = {
    indigo: "text-indigo-600",
    amber: "text-amber-600",
    purple: "text-purple-600",
    emerald: "text-emerald-600",
  };
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`text-3xl font-bold ${accentMap[accent]} mt-1`}>{value}</p>
    </div>
  );
}

function Ratio({ numer, denom }: { numer: number; denom: number }) {
  if (denom === 0) return <span className="text-gray-300">—</span>;
  const pct = Math.round((numer / denom) * 100);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-gray-900">{numer}/{denom}</span>
      <span className="text-xs text-gray-500">({pct}%)</span>
    </span>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-64 text-gray-500 gap-3">
      <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      {label}
    </div>
  );
}

function ErrorBox({ error }: { error: string }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
      <strong>Error:</strong> {error}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
      <div className="mx-auto w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center mb-4">
        <svg className="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-gray-900">Waiting for first REDCap fetch</h3>
      <p className="text-sm text-gray-500 mt-2 max-w-md mx-auto">
        Once the data pipeline has run once with a valid <code className="px-1 py-0.5 bg-gray-100 rounded">REDCAP_API_TOKEN</code> set,
        the participant directory will appear here.
      </p>
    </div>
  );
}

function FetchBanner({ lastFetch }: { lastFetch: LastFetch | null }) {
  if (!lastFetch?.timestamp) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800 flex items-center justify-between">
        <span>No data pipeline run recorded yet.</span>
      </div>
    );
  }
  if (!lastFetch.ok) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
        <strong>Last fetch failed</strong> at {formatDateTime(lastFetch.timestamp)} — {lastFetch.error}
      </div>
    );
  }
  return (
    <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-800 flex items-center justify-between">
      <span>
        Last fetch: <strong>{formatDateTime(lastFetch.timestamp)}</strong>
        {lastFetch.counts ? ` · ${lastFetch.counts.participants} participants · ${lastFetch.counts.dueNext7Days} reminders queued` : ""}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- charts --
   Response distribution and per-wave progress, drawn as inline SVG so the
   dashboard carries no charting dependency.
   ------------------------------------------------------------------------ */

function PromptHistogram({ participants }: { participants: Participant[] }) {
  // Bucket participants by how many prompts of their cycle they answered.
  const BUCKETS = [
    { label: "0", lo: 0, hi: 0 },
    { label: "1–5", lo: 1, hi: 5 },
    { label: "6–10", lo: 6, hi: 10 },
    { label: "11–15", lo: 11, hi: 15 },
    { label: "16–20", lo: 16, hi: 20 },
    { label: "21–25", lo: 21, hi: 25 },
  ];
  const counts = BUCKETS.map(() => 0);
  let withCycle = 0;
  for (const p of participants) {
    for (const w of Object.values(p.waves || {})) {
      const ema = w?.ema;
      if (!ema || !ema.active) continue;
      withCycle++;
      const n = ema.promptsCompleteCount ?? 0;
      const i = BUCKETS.findIndex(b => n >= b.lo && n <= b.hi);
      if (i >= 0) counts[i]++;
      break;
    }
  }
  const max = Math.max(1, ...counts);
  const H = 132, W = 420, pad = 26, TOP = 16, bw = (W - pad * 2) / BUCKETS.length;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-base font-semibold text-gray-900">Response distribution</h3>
        <span className="text-xs text-gray-500">{withCycle} active cycles</span>
      </div>
      <p className="text-xs text-gray-500 mb-3">Prompts answered per participant, out of 25.</p>
      <svg viewBox={`0 ${-TOP} ${W} ${H + 26 + TOP}`} className="w-full" role="img"
           aria-label="Histogram of prompts answered per participant">
        {[0.25, 0.5, 0.75, 1].map(f => (
          <line key={f} x1={pad} x2={W - pad} y1={H - H * f} y2={H - H * f}
                stroke="#eef0f4" strokeWidth="1" />
        ))}
        {counts.map((c, i) => {
          const h = (c / max) * (H - 10);
          const x = pad + i * bw + bw * 0.18;
          const bwid = bw * 0.64;
          return (
            <g key={i}>
              <rect x={x} y={H - h} width={bwid} height={h} rx="3" fill="url(#gBar)" />
              {c > 0 && (
                <text x={x + bwid / 2} y={H - h - 5} textAnchor="middle"
                      fontSize="10" fill="#6b7280" fontWeight="600">{c}</text>
              )}
              <text x={x + bwid / 2} y={H + 16} textAnchor="middle"
                    fontSize="10" fill="#9ca3af">{BUCKETS[i].label}</text>
            </g>
          );
        })}
        <line x1={pad} x2={W - pad} y1={H} y2={H} stroke="#d1d5db" strokeWidth="1" />
        <defs>
          <linearGradient id="gBar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" />
            <stop offset="100%" stopColor="#6366f1" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

function WaveProgress({ stats }: { stats: ReturnType<typeof computeStats> }) {
  // Denominator is participant-waves: the same person can be past a stage in
  // more than one wave, so dividing by head-count can exceed 100%.
  const total = Math.max(1, WAVE_YEARS.reduce((a, w) => a + stats.byWave[w], 0));
  const ROWS: { label: string; get: (w: WaveYear) => number; color: string }[] = [
    { label: "V1", get: w => stats.v1Complete[w], color: "#6366f1" },
    { label: "At-home", get: w => stats.atHomeComplete[w], color: "#8b5cf6" },
    { label: "Cycles", get: w => stats.stsComplete[w], color: "#a855f7" },
    { label: "EMA", get: w => stats.emaComplete[w], color: "#ec4899" },
    { label: "V2", get: w => stats.v2Complete[w], color: "#10b981" },
  ];
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-base font-semibold text-gray-900">Completion by stage</h3>
        <span className="text-xs text-gray-500">of {total} participant-waves</span>
      </div>
      <p className="text-xs text-gray-500 mb-3">Share of the roster past each stage, per wave.</p>
      <div className="space-y-2.5">
        {ROWS.map(r => {
          const vals = WAVE_YEARS.map(w => r.get(w));
          const sum = vals.reduce((a, b) => a + b, 0);
          return (
            <div key={r.label} className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-xs font-medium text-gray-600">{r.label}</span>
              <div className="flex-1 h-5 rounded-md bg-gray-100 overflow-hidden flex">
                {vals.map((v, i) => (
                  <div key={i} title={`${WAVE_LABELS[WAVE_YEARS[i]]}: ${v}`}
                       style={{ width: `${(v / total) * 100}%`, background: r.color,
                                opacity: 1 - i * 0.28 }} />
                ))}
              </div>
              <span className="w-14 shrink-0 text-right text-xs tabular-nums text-gray-700 font-medium">
                {Math.round((sum / total) * 100)}%
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 mt-3 pt-3 border-t border-gray-100">
        {WAVE_YEARS.map((w, i) => (
          <span key={w} className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <span className="w-2.5 h-2.5 rounded-sm bg-gray-700"
                  style={{ opacity: 1 - i * 0.28 }} />
            {WAVE_LABELS[w]}
          </span>
        ))}
      </div>
    </div>
  );
}
