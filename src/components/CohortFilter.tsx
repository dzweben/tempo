"use client";

import { useCohort, type Cohort } from "@/lib/cohort";

const OPTIONS: { value: Cohort; label: string }[] = [
  { value: "all", label: "All cohorts" },
  { value: "1",   label: "1000s" },
  { value: "2",   label: "2000s" },
  { value: "3",   label: "3000s" },
];

// Reusable pill row. Drop in to any page; reads/writes a single shared
// localStorage value so the user's choice persists across navigation.
//
//   const [cohort] = useCohort();           // read the active selection
//   <CohortFilter />                        // render the picker
//   xs.filter(p => cohortMatches(p.pid, cohort))
//
export default function CohortFilter() {
  const [cohort, setCohort] = useCohort();
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wider text-gray-500">Cohort</span>
      <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
        {OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setCohort(opt.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              cohort === opt.value
                ? "bg-indigo-600 text-white"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
