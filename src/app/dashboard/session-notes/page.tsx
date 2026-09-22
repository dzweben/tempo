"use client";

import { useEffect, useState } from "react";

// The PID Session Notes workbook (cohort tabs 1000/2000/3000) — the team's
// V1/V2 source of truth. We embed the LIVE editable Google Sheet here so
// coordinators can read AND edit it without leaving the dashboard. The
// iframe loads Google's real editor, which uses the viewer's own Google
// login for edit access — nothing is exposed publicly.
//
// Sheet ID resolution: prefer whatever the data pipeline actually used
// (surfaced in last-fetch.json), falling back to the known workbook ID so
// the page works even before the next fetch writes the field.
const FALLBACK_SHEET_ID = "YOUR_GOOGLE_SHEET_ID";

// Zoom presets — scaling the iframe DOWN shows more of the sheet at once.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.1;
// Start a bit zoomed out so more of the sheet is visible on first load.
const DEFAULT_ZOOM = 0.8;

export default function SessionNotesPage() {
  const [sheetId, setSheetId] = useState<string>(FALLBACK_SHEET_ID);
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);

  useEffect(() => {
    fetch("/api/data/last-fetch")
      .then(r => r.json())
      .then(d => { if (d?.sheetId) setSheetId(d.sheetId); })
      .catch(() => { /* keep fallback */ });
  }, []);

  // Persist the user's preferred zoom across visits.
  useEffect(() => {
    const saved = Number(localStorage.getItem("sessionNotesZoom"));
    if (saved >= ZOOM_MIN && saved <= ZOOM_MAX) setZoom(saved);
  }, []);
  useEffect(() => { localStorage.setItem("sessionNotesZoom", String(zoom)); }, [zoom]);

  const clamp = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
  const zoomOut = () => setZoom(z => clamp(z - ZOOM_STEP));
  const zoomIn = () => setZoom(z => clamp(z + ZOOM_STEP));
  const resetZoom = () => setZoom(1);

  const editUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit?usp=sharing&rm=minimal`;
  const openUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] gap-3">
      <div className="flex items-start justify-between gap-4 flex-wrap shrink-0">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Session Notes</h2>
          <p className="text-sm text-gray-500 mt-1">
            The live cohort workbook (tabs 1000 / 2000 / 3000) — the source of truth for V1/V2 dates.
            Edit it right here; changes save straight to Google. You must be signed into a Google
            account with access to the sheet.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Zoom controls — scale the embed to fit more on screen */}
          <div className="inline-flex items-center rounded-lg border border-gray-200 bg-white">
            <button
              onClick={zoomOut}
              disabled={zoom <= ZOOM_MIN}
              title="Zoom out (show more)"
              className="px-2.5 py-2 text-gray-600 hover:bg-gray-50 disabled:opacity-30 disabled:hover:bg-white rounded-l-lg"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM7 10h6" />
              </svg>
            </button>
            <button
              onClick={resetZoom}
              title="Reset to 100%"
              className="px-2 py-2 text-xs font-mono font-semibold text-gray-700 hover:bg-gray-50 tabular-nums min-w-[3.25rem]"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              onClick={zoomIn}
              disabled={zoom >= ZOOM_MAX}
              title="Zoom in"
              className="px-2.5 py-2 text-gray-600 hover:bg-gray-50 disabled:opacity-30 disabled:hover:bg-white rounded-r-lg"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7" />
              </svg>
            </button>
          </div>
          <a
            href={openUrl}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
          >
            Open in Google Sheets
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      </div>

      <div className="flex-1 min-h-0 rounded-xl border border-gray-200 overflow-hidden bg-white">
        {/* Scale the iframe down to zoom out: the inverse width/height keeps
            the scaled frame filling the visible area so no blank gap shows. */}
        <iframe
          src={editUrl}
          title="PID Session Notes"
          allow="clipboard-read; clipboard-write"
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
            width: `${100 / zoom}%`,
            height: `${100 / zoom}%`,
            border: "0",
          }}
        />
      </div>

      <p className="text-xs text-gray-400 shrink-0">
        Use the −/+ buttons to zoom the sheet (click the % to reset). Not seeing the sheet? Make sure
        you&rsquo;re logged into the Google account that has access, then reload — or use “Open in
        Google Sheets”.
      </p>
    </div>
  );
}
