"use client";

import { useEffect, useState, useMemo } from "react";
import type { Participant, WaveYear } from "@/types";
import { WAVE_YEARS, WAVE_LABELS, pidSort, formatDate, pillColor, stsCompleteCount, stsAllComplete } from "@/lib/tempo-utils";
import { useCohort, cohortMatches } from "@/lib/cohort";
import CohortFilter from "@/components/CohortFilter";

export default function WavesPage() {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeWave, setActiveWave] = useState<WaveYear>(1);
  const [search, setSearch] = useState("");
  const [cohort] = useCohort();

  useEffect(() => {
    fetch("/api/data/participants").then(r => r.json()).then(d => {
      setParticipants((d.participants || []).slice().sort(pidSort));
    }).finally(() => setLoading(false));
  }, []);

  const rows = useMemo(() => {
    let xs = participants.filter(p => p.waves[activeWave] && cohortMatches(p.pid, cohort));
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      xs = xs.filter(p => p.pid.toLowerCase().includes(s));
    }
    return xs;
  }, [participants, activeWave, search, cohort]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Visit + Survey Overview</h2>
          <p className="text-sm text-gray-500 mt-1">
            Per-wave participant grid. Each row shows the full lifecycle:
            V1 → at-home → STS1 → STS2 → EMA → V2.
          </p>
        </div>
        <CohortFilter />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
          {WAVE_YEARS.map(w => (
            <button
              key={w}
              onClick={() => setActiveWave(w)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                activeWave === w ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {WAVE_LABELS[w]}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search PID…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <span className="text-sm text-gray-500 ml-auto">{rows.length} in {WAVE_LABELS[activeWave]}</span>
      </div>

      {loading ? <p className="text-gray-500 text-sm">Loading…</p> : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                  <th className="text-left px-4 py-3 font-semibold">PID</th>
                  <th className="text-center px-4 py-3 font-semibold">V1</th>
                  <th className="text-center px-4 py-3 font-semibold">At-home</th>
                  <th className="text-center px-4 py-3 font-semibold">STS1 (1-6)</th>
                  <th className="text-center px-4 py-3 font-semibold">EMA</th>
                  <th className="text-center px-4 py-3 font-semibold">STS2 (1-3)</th>
                  <th className="text-center px-4 py-3 font-semibold">V2</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={7} className="py-10 text-center text-gray-400">No participants in this wave yet.</td></tr>
                )}
                {rows.map(p => {
                  const w = p.waves[activeWave]!;
                  const ahLabel = w.atHome?.athomeMeasuresComplete === 2
                    ? "Complete"
                    : (w.atHome?.sectionsTotal != null && w.atHome.sectionsTotal > 0
                      ? `${w.atHome.sectionsComplete ?? 0}/${w.atHome.sectionsTotal}`
                      : (w.atHome?.timestamp ? "Started" : "—"));
                  return (
                    <tr key={p.pid} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3 font-mono font-medium">{p.pid}</td>
                      <td className="px-4 py-3 text-center">
                        <Pill
                          color={w.v1?.allComplete ? "emerald" : w.v1 ? "amber" : "gray"}
                          label={w.v1?.date ? formatDate(w.v1.date) : "—"}
                        />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Pill
                          color={w.atHome?.athomeMeasuresComplete === 2 ? "emerald" : (w.atHome?.athomeMeasuresComplete === 1 || w.atHome?.timestamp) ? "amber" : "gray"}
                          label={ahLabel}
                        />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <CycleStrip n={6} done={stsCompleteCount(w.sts1)} active={!!w.sts1?.active} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Pill
                          color={w.ema?.active ? "purple" : "gray"}
                          label={w.ema?.active ? `${w.ema.promptsCompleteCount ?? w.ema.prompts.filter(p => p.complete).length}/${w.ema.promptsTotal ?? w.ema.prompts.length}` : "—"}
                        />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <CycleStrip n={3} done={stsCompleteCount(w.sts2)} active={!!w.sts2?.active} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Pill
                          color={w.v2?.allComplete ? "emerald" : w.v2 ? "amber" : "gray"}
                          label={w.v2?.date ? formatDate(w.v2.date) : "—"}
                        />
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

function Pill({ color, label }: { color: "emerald" | "amber" | "gray" | "purple"; label: string }) {
  const map = {
    emerald: "bg-emerald-100 text-emerald-700",
    amber: "bg-amber-100 text-amber-700",
    gray: "bg-gray-100 text-gray-500",
    purple: "bg-purple-100 text-purple-700",
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${map[color]}`}>{label}</span>;
}

function CycleStrip({ n, done, active }: { n: number; done: number; active: boolean }) {
  return (
    <div className="inline-flex gap-0.5">
      {Array.from({ length: n }).map((_, i) => (
        <span
          key={i}
          className={`inline-block w-3.5 h-3.5 rounded ${
            !active ? "bg-gray-100" :
            i < done ? "bg-emerald-500" : "bg-gray-200"
          }`}
          title={`${i + 1}`}
        />
      ))}
    </div>
  );
}
