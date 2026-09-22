"use client";

import React, { useEffect, useState, useMemo } from "react";
import type { Participant, WaveYear } from "@/types";
import { WAVE_YEARS, WAVE_LABELS, pidSort, formatDateTime, EMA_DONE_THRESHOLD, EMA_TOTAL, isEmaDone } from "@/lib/tempo-utils";
import { useCohort, cohortMatches } from "@/lib/cohort";
import CohortFilter from "@/components/CohortFilter";

export default function EMAPage() {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [wave, setWave] = useState<WaveYear>(1);
  const [expandedPid, setExpandedPid] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [cohort] = useCohort();

  useEffect(() => {
    fetch("/api/data/participants").then(r => r.json()).then(d => {
      setParticipants((d.participants || []).slice().sort(pidSort));
    }).finally(() => setLoading(false));
  }, []);

  const rows = useMemo(() => {
    // EMA is a 13+ instrument — under-13 participants are never sent
    // prompts, so they're filtered out entirely. Unknown age falls
    // through (better to surface and let the coordinator notice than
    // hide silently).
    let xs = participants.filter(p => {
      if (!cohortMatches(p.pid, cohort)) return false;
      // HARD STUDY RULE: cohort 1 (1000s) never gets EMA, at any age.
      if (/^1\d{3}$/.test(p.pid)) return false;
      const age = p.contact?.age;
      if (typeof age === "number" && age < 13) return false;
      const w = p.waves[wave];
      return !!(w?.ema || w?.followupSheet);
    });
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      xs = xs.filter(p => p.pid.toLowerCase().includes(s));
    }
    return xs;
  }, [participants, wave, search, cohort]);

  // Headline: % of participants who completed >= 10 of 25 EMAs.
  const stats = useMemo(() => {
    const total = rows.length;
    let metThreshold = 0;
    for (const p of rows) {
      if (isEmaDone(p.waves[wave])) metThreshold++;
    }
    const pct = total > 0 ? Math.round((metThreshold / total) * 100) : 0;
    return { total, metThreshold, pct };
  }, [rows, wave]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">EMA Tracker</h2>
          <p className="text-sm text-gray-500 mt-1">
            Ecological Momentary Assessment — 25 timed micro-surveys per active cycle.
            Threshold for "done" = at least {EMA_DONE_THRESHOLD} of {EMA_TOTAL}.
          </p>
        </div>
        <CohortFilter />
      </div>

      {/* Headline */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="In this wave" value={stats.total} accent="indigo" />
        <Stat
          label={`≥${EMA_DONE_THRESHOLD} of ${EMA_TOTAL} done`}
          value={stats.metThreshold}
          suffix={`/${stats.total}`}
          accent="emerald"
        />
        <Stat label="% meeting threshold" value={stats.pct} suffix="%" accent="amber" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
          {WAVE_YEARS.map(w => (
            <button
              key={w}
              onClick={() => setWave(w)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md ${
                wave === w ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {WAVE_LABELS[w]}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="PID…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <span className="text-sm text-gray-500 ml-auto">{rows.length} shown</span>
      </div>

      {loading ? <p className="text-gray-500 text-sm">Loading…</p> : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                <th className="text-left px-4 py-3 font-semibold">PID</th>
                <th className="text-left px-4 py-3 font-semibold">EMA Phone</th>
                <th className="text-left px-4 py-3 font-semibold">Start Day</th>
                <th className="text-center px-4 py-3 font-semibold">Done</th>
                <th className="text-center px-4 py-3 font-semibold">Scheduled</th>
                <th className="text-center px-4 py-3 font-semibold">≥{EMA_DONE_THRESHOLD}/{EMA_TOTAL}?</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={7} className="py-10 text-center text-gray-400">No participants match.</td></tr>
              )}
              {rows.map(p => {
                const ema = p.waves[wave]?.ema ?? null;
                const done = ema?.prompts.filter(x => x.complete).length ?? 0;
                const scheduled = ema?.prompts.filter(x => x.scheduledAt).length ?? 0;
                const meets = done >= EMA_DONE_THRESHOLD;
                const expanded = expandedPid === p.pid;
                return (
                  <Row
                    key={p.pid}
                    pid={p.pid}
                    ema={ema}
                    expanded={expanded}
                    onToggle={() => setExpandedPid(expanded ? null : p.pid)}
                    done={done}
                    scheduled={scheduled}
                    meets={meets}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, suffix, accent }: { label: string; value: number; suffix?: string; accent: "indigo" | "emerald" | "amber" }) {
  const c = {
    indigo: "text-indigo-600",
    emerald: "text-emerald-600",
    amber: "text-amber-600",
  }[accent];
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold ${c} mt-1 tabular-nums`}>
        {value}<span className="text-base text-gray-400 font-medium">{suffix || ""}</span>
      </p>
    </div>
  );
}

function Row({ pid, ema, expanded, onToggle, done, scheduled, meets }: {
  pid: string;
  ema: NonNullable<Participant["waves"][1]>["ema"] | null;
  expanded: boolean;
  onToggle: () => void;
  done: number;
  scheduled: number;
  meets: boolean;
}) {
  return (
    <React.Fragment>
      <tr
        className={`border-b border-gray-100 hover:bg-gray-50 cursor-pointer ${expanded ? "bg-indigo-50/40" : ""}`}
        onClick={onToggle}
      >
        <td className="px-4 py-3 font-mono font-medium">{pid}</td>
        <td className="px-4 py-3 text-gray-700 font-mono text-xs">{ema?.phone || "—"}</td>
        <td className="px-4 py-3 text-gray-700">{ema?.startDay || "—"}</td>
        <td className="px-4 py-3 text-center font-mono">{done}</td>
        <td className="px-4 py-3 text-center font-mono">{scheduled}</td>
        <td className="px-4 py-3 text-center">
          {meets ? (
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 text-emerald-700">✓</span>
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-right text-gray-400 text-xs">{ema ? (expanded ? "▲" : "▼") : ""}</td>
      </tr>
      {expanded && ema && (
        <tr>
          <td colSpan={7} className="bg-gray-50 px-6 py-4 border-b border-gray-200">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {ema.prompts.map(p => (
                <div
                  key={p.key}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded ${
                    p.complete ? "bg-emerald-50 text-emerald-800" :
                    p.scheduledAt ? "bg-white border border-gray-200" :
                    "bg-gray-100 text-gray-400"
                  }`}
                >
                  <span className="text-xs font-medium">{p.dayLabel} · {p.timeLabel}</span>
                  <span className="text-xs font-mono">
                    {p.complete ? "✓" : p.scheduledAt ? formatDateTime(p.scheduledAt).slice(0, -3) : "—"}
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </React.Fragment>
  );
}
