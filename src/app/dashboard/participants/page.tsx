"use client";

import React, { useEffect, useState, useMemo } from "react";
import type { Participant } from "@/types";
import { pidSort, formatDate, WAVE_LABELS } from "@/lib/tempo-utils";
import { useCohort, cohortMatches } from "@/lib/cohort";
import CohortFilter from "@/components/CohortFilter";

export default function ParticipantsPage() {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [waveFilter, setWaveFilter] = useState<"all" | "1" | "2" | "3">("all");
  const [expandedPid, setExpandedPid] = useState<string | null>(null);
  const [cohort] = useCohort();

  useEffect(() => {
    fetch("/api/data/participants")
      .then(r => r.json())
      .then(d => setParticipants((d.participants || []).slice().sort(pidSort)))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let xs = participants.filter(p => cohortMatches(p.pid, cohort));
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      xs = xs.filter(p =>
        p.pid.toLowerCase().includes(s)
        || p.contact.email.toLowerCase().includes(s)
      );
    }
    if (waveFilter !== "all") {
      const w = Number(waveFilter) as 1 | 2 | 3;
      xs = xs.filter(p => p.waves[w]);
    }
    return xs;
  }, [participants, search, waveFilter, cohort]);

  if (loading) return <p className="text-gray-500 text-sm">Loading…</p>;
  if (error) return <p className="text-red-600 text-sm">{error}</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Participants</h2>
          <p className="text-sm text-gray-500 mt-1">
            {participants.length} total · contact info, active wave, and quick status.
          </p>
        </div>
        <CohortFilter />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by PID, name, or email…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[240px] max-w-sm px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <select
          value={waveFilter}
          onChange={e => setWaveFilter(e.target.value as "all" | "1" | "2" | "3")}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">All waves</option>
          <option value="1">Has Year 1</option>
          <option value="2">Has Year 2</option>
          <option value="3">Has Year 3</option>
        </select>
        <span className="text-sm text-gray-500 ml-auto">{filtered.length} shown</span>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
              <th className="text-left px-4 py-3 font-semibold">PID</th>
              <th className="text-left px-4 py-3 font-semibold">Email</th>
              <th className="text-left px-4 py-3 font-semibold">Phone</th>
              <th className="text-center px-4 py-3 font-semibold">Active Wave</th>
              <th className="text-center px-4 py-3 font-semibold">Cohort</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="py-10 text-center text-gray-400">No participants match.</td></tr>
            )}
            {filtered.map(p => (
              <ParticipantRow
                key={p.pid}
                p={p}
                expanded={expandedPid === p.pid}
                onToggle={() => setExpandedPid(expandedPid === p.pid ? null : p.pid)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ParticipantRow({ p, expanded, onToggle }: { p: Participant; expanded: boolean; onToggle: () => void }) {
  return (
    <React.Fragment>
      <tr
        className={`border-b border-gray-100 hover:bg-gray-50 cursor-pointer ${expanded ? "bg-indigo-50/40" : ""}`}
        onClick={onToggle}
      >
        <td className="px-4 py-3 font-mono font-medium text-gray-900">{p.pid}</td>
        <td className="px-4 py-3 text-gray-600 truncate max-w-xs">{p.contact.email || "—"}</td>
        <td className="px-4 py-3 text-gray-600">{p.contact.phonePrimary || "—"}</td>
        <td className="px-4 py-3 text-center">
          {p.activeWave ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold bg-indigo-100 text-indigo-700">
              {WAVE_LABELS[p.activeWave]}
            </span>
          ) : <span className="text-gray-400">—</span>}
        </td>
        <td className="px-4 py-3 text-center text-gray-600">{p.contact.cohortGroup || "—"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} className="bg-gray-50 px-6 py-5 border-b border-gray-200">
            <ParticipantDetail p={p} />
          </td>
        </tr>
      )}
    </React.Fragment>
  );
}

function ParticipantDetail({ p }: { p: Participant }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-sm">
      <Section title="Contact">
        <KV label="Parent name" value={p.contact.parentName} />
        <KV label="Primary phone" value={p.contact.phonePrimary} />
        <KV label="Secondary phone" value={p.contact.phoneSecondary} />
        <KV label="Child phone" value={p.contact.childPhone} />
      </Section>
      {[1, 2, 3].map(w => {
        const wave = p.waves[w as 1 | 2 | 3];
        if (!wave) return null;
        return (
          <Section key={w} title={WAVE_LABELS[w as 1 | 2 | 3]}>
            <KV label="V1" value={wave.v1?.date ? formatDate(wave.v1.date) : "—"} />
            <KV label="At-home start" value={wave.atHome?.timestamp ? formatDate(wave.atHome.timestamp) : "—"} />
            <KV label="STS1 cycles done" value={`${wave.sts1?.cycles.filter(c => c.complete === 2).length ?? 0}/${wave.sts1?.cycles.length ?? 0}`} />
            <KV label="STS2 cycles done" value={`${wave.sts2?.cycles.filter(c => c.complete === 2).length ?? 0}/${wave.sts2?.cycles.length ?? 0}`} />
            <KV label="EMA active" value={wave.ema?.active ? "yes" : "no"} />
            <KV label="V2" value={wave.v2?.date ? formatDate(wave.v2.date) : "—"} />
          </Section>
        );
      })}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">{title}</h4>
      <dl className="space-y-1">{children}</dl>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-3 text-gray-700">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-mono text-xs">{value || "—"}</dd>
    </div>
  );
}
