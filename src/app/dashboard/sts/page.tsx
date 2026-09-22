"use client";

import { useEffect, useState, useMemo } from "react";
import type { Participant, WaveYear, STSCycle, FollowupSheetRow } from "@/types";
import { WAVE_YEARS, WAVE_LABELS, pidSort, formatMonthShort, COMPLETION_LABELS } from "@/lib/tempo-utils";
import { useCohort, cohortMatches } from "@/lib/cohort";
import CohortFilter from "@/components/CohortFilter";

// "Done" threshold: 5 of 9 total STS surveys per year (STS1 6 + STS2 3).
const STS_DONE_THRESHOLD = 5;
const STS_TOTAL = 9;

interface CombinedCycle {
  label: string;             // "1.1", "1.2", ..., "2.1", "2.3"
  complete: 0 | 1 | 2;
  date: string | null;
  surveyLink: string | null;
  scheduleMonth: string | null;  // from followupSheet when REDCap is missing
}

function combinedCycles(p: Participant, wave: WaveYear): CombinedCycle[] {
  const w = p.waves[wave];
  const sheet: FollowupSheetRow | undefined = w?.followupSheet;
  const sts1Cycles: STSCycle[] | undefined = w?.sts1?.cycles;
  const sts2Cycles: STSCycle[] | undefined = w?.sts2?.cycles;
  const sts1Months = sheet?.sts1Months ?? [];
  const sts2Months = sheet?.sts2Months ?? [];

  const out: CombinedCycle[] = [];
  // STS1 cycles 1-6
  for (let i = 0; i < 6; i++) {
    const c = sts1Cycles?.[i];
    const m = sts1Months[i];
    out.push({
      label: `1.${i + 1}`,
      complete: (c?.complete ?? 0) as 0 | 1 | 2,
      date: c?.date ?? null,
      surveyLink: c?.surveyLink ?? null,
      scheduleMonth: m != null && String(m).trim() !== "" ? String(m).trim() : null,
    });
  }
  // STS2 cycles 1-3
  for (let i = 0; i < 3; i++) {
    const c = sts2Cycles?.[i];
    const m = sts2Months[i];
    out.push({
      label: `2.${i + 1}`,
      complete: (c?.complete ?? 0) as 0 | 1 | 2,
      date: c?.date ?? null,
      surveyLink: c?.surveyLink ?? null,
      scheduleMonth: m != null && String(m).trim() !== "" ? String(m).trim() : null,
    });
  }
  return out;
}

export default function STSPage() {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [wave, setWave] = useState<WaveYear>(1);
  const [search, setSearch] = useState("");
  const [cohort] = useCohort();

  useEffect(() => {
    fetch("/api/data/participants").then(r => r.json()).then(d => {
      setParticipants((d.participants || []).slice().sort(pidSort));
    }).finally(() => setLoading(false));
  }, []);

  const rows = useMemo(() => {
    // Show ANYONE tracked for this wave: either they have REDCap STS data
    // OR they're listed in the cohort sheet for this wave. PIDs 3156/3157
    // belong here even though REDCap hasn't provisioned their STS event yet.
    let xs = participants.filter(p => {
      if (!cohortMatches(p.pid, cohort)) return false;
      const w = p.waves[wave];
      return !!(w?.sts1 || w?.sts2 || w?.followupSheet);
    });
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      xs = xs.filter(p => p.pid.toLowerCase().includes(s));
    }
    return xs;
  }, [participants, wave, search, cohort]);

  // Headline stats
  const stats = useMemo(() => {
    const total = rows.length;
    let metThreshold = 0;
    let totalDoneCount = 0;
    for (const p of rows) {
      const cycles = combinedCycles(p, wave);
      const done = cycles.filter(c => c.complete === 2).length;
      if (done >= STS_DONE_THRESHOLD) metThreshold++;
      totalDoneCount += done;
    }
    const pct = total > 0 ? Math.round((metThreshold / total) * 100) : 0;
    return { total, metThreshold, pct, totalDoneCount };
  }, [rows, wave]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Screen Time Surveys</h2>
          <p className="text-sm text-gray-500 mt-1">
            Combined view: STS1 (6 cycles) + STS2 (3 cycles) = 9 total per year. Threshold for "done" = at least 5 of 9.
          </p>
        </div>
        <CohortFilter />
      </div>

      {/* Headline */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="In this wave" value={stats.total} accent="indigo" />
        <Stat label="≥5 of 9 STS done" value={stats.metThreshold} suffix={`/${stats.total}`} accent="emerald" />
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                  <th className="text-left px-4 py-3 font-semibold">PID</th>
                  {/* STS1 */}
                  {Array.from({ length: 6 }).map((_, i) => (
                    <th key={`s1${i}`} className="text-center px-2 py-3 font-semibold text-indigo-600">
                      1.{i + 1}
                    </th>
                  ))}
                  {/* divider visually via border */}
                  {Array.from({ length: 3 }).map((_, i) => (
                    <th key={`s2${i}`} className={`text-center px-2 py-3 font-semibold text-purple-600 ${i === 0 ? "border-l border-gray-200" : ""}`}>
                      2.{i + 1}
                    </th>
                  ))}
                  <th className="text-center px-4 py-3 font-semibold border-l border-gray-200">Done</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={STS_TOTAL + 2} className="py-10 text-center text-gray-400">No participants match.</td></tr>
                )}
                {rows.map(p => {
                  const cycles = combinedCycles(p, wave);
                  const done = cycles.filter(c => c.complete === 2).length;
                  const meets = done >= STS_DONE_THRESHOLD;
                  return (
                    <tr key={p.pid} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3 font-mono font-medium">{p.pid}</td>
                      {cycles.map((c, idx) => (
                        <td key={c.label} className={`px-2 py-3 text-center ${idx === 6 ? "border-l border-gray-200" : ""}`}>
                          <CycleCell c={c} />
                        </td>
                      ))}
                      <td className="px-4 py-3 text-center border-l border-gray-200">
                        <span className={`font-mono font-semibold ${meets ? "text-emerald-700" : "text-gray-600"}`}>
                          {done}/{STS_TOTAL}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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

function CycleCell({ c }: { c: CombinedCycle }) {
  // Three visual states:
  //   complete=2 → green, label "C"
  //   complete=1 → amber, label "U" (unverified)
  //   complete=0 → gray; if there's a REDCap date or a sheet schedule month, show it
  const colorMap = {
    2: "bg-emerald-500 text-white",
    1: "bg-amber-300 text-amber-900",
    0: "bg-gray-100 text-gray-500",
  } as const;
  // What to show under the status letter: REDCap date if present, else
  // the sheet's scheduled month label, else em-dash.
  const subLabel = c.date
    ? formatMonthShort(c.date)
    : (c.scheduleMonth || "—");
  const cell = (
    <div className={`inline-flex flex-col items-center px-2 py-1 rounded min-w-[56px] ${colorMap[c.complete]}`}>
      <span className="text-xs font-semibold">{COMPLETION_LABELS[c.complete][0]}</span>
      <span className="text-[10px] font-mono mt-0.5 opacity-75">{subLabel}</span>
    </div>
  );
  if (c.surveyLink && c.complete !== 2) {
    return <a href={c.surveyLink} target="_blank" rel="noopener" className="hover:opacity-80 inline-block">{cell}</a>;
  }
  return cell;
}
