// Cohort filter shared across the whole dashboard.
//
// Cohorts derive purely from PID prefix:
//   1000-1999 = Cohort 1
//   2000-2999 = Cohort 2
//   3000-3999 = Cohort 3
//
// The state lives in a React Context so the CohortFilter picker and every
// page that calls useCohort() see the same value. The selection persists
// in localStorage and survives reloads.

"use client";

import React, { createContext, useContext, useEffect, useState, useCallback } from "react";

export type Cohort = "all" | "1" | "2" | "3";

const STORAGE_KEY = "tempo-cohort-filter";

export function cohortOfPid(pid: string): "1" | "2" | "3" | null {
  const n = Number(String(pid).replace(/\.0$/, ""));
  if (!isFinite(n)) return null;
  if (n >= 1000 && n <= 1999) return "1";
  if (n >= 2000 && n <= 2999) return "2";
  if (n >= 3000 && n <= 3999) return "3";
  return null;
}

export function cohortMatches(pid: string, c: Cohort): boolean {
  if (c === "all") return true;
  return cohortOfPid(pid) === c;
}

interface Ctx {
  cohort: Cohort;
  setCohort: (c: Cohort) => void;
}

const CohortCtx = createContext<Ctx | null>(null);

export function CohortProvider({ children }: { children: React.ReactNode }) {
  const [cohort, setCohortState] = useState<Cohort>("all");

  // Restore from localStorage once on mount.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "all" || stored === "1" || stored === "2" || stored === "3") {
        setCohortState(stored);
      }
    } catch { /* localStorage blocked — ignore */ }
  }, []);

  const setCohort = useCallback((next: Cohort) => {
    setCohortState(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  }, []);

  return (
    <CohortCtx.Provider value={{ cohort, setCohort }}>
      {children}
    </CohortCtx.Provider>
  );
}

// Returns [cohort, setCohort]. Throws if called outside CohortProvider.
export function useCohort(): [Cohort, (c: Cohort) => void] {
  const ctx = useContext(CohortCtx);
  if (!ctx) throw new Error("useCohort() must be used inside <CohortProvider>");
  return [ctx.cohort, ctx.setCohort];
}
