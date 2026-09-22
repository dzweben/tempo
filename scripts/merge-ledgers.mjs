#!/usr/bin/env node
/**
 * Union-merge the send ledgers with origin/main before committing.
 *
 * Ledgers are APPEND-ONLY: every row is a fact about a message that was
 * (or wasn't) sent. The refresh pipeline's `-X theirs` rebase strategy
 * is right for regenerated files (queue, participants — freshest fetch
 * wins) but catastrophically wrong for ledgers: on conflict it replaces
 * the file wholesale, silently deleting rows another run appended. That
 * is exactly how the 2026-08-09 double-send happened — a dispatched run
 * on a stale snapshot re-sent 74 messages, then its commit erased the
 * first run's 74 rows.
 *
 * Run this immediately before `git add` in the commit step: it fetches
 * origin/main's copy of each ledger and unions it with the local copy,
 * so whatever the rebase does afterwards, our committed file already
 * CONTAINS every row both sides know about.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "private", "data");

// (file, identity function) — a row is the same fact iff identity matches.
const LEDGERS = [
  ["sent-log.json", (e) => e.sendKey || `${e.id}|${e.channel}|${e.recipient}|${e.timestamp}`],
  ["ema-sent-log.json", (e) => `${e.key}|${e.status}|${e.dryRun ? "dry" : "real"}|${e.at || ""}`],
];

try { execSync("git fetch origin main", { stdio: "pipe" }); } catch { /* offline: local-only union is still fine */ }

for (const [file, identity] of LEDGERS) {
  const localPath = path.join(DATA_DIR, file);
  let local = [];
  try { local = JSON.parse(fs.readFileSync(localPath, "utf-8")); } catch { /* absent locally */ }
  let remote = [];
  try {
    remote = JSON.parse(execSync(`git show origin/main:app/private/data/${file}`,
      { stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).toString());
  } catch { /* file doesn't exist on origin yet */ }

  const seen = new Set(local.map(identity));
  const missing = remote.filter(e => !seen.has(identity(e)));
  if (missing.length > 0) {
    const merged = [...local, ...missing].sort((a, b) =>
      String(a.timestamp || a.at || "").localeCompare(String(b.timestamp || b.at || "")));
    fs.writeFileSync(localPath, JSON.stringify(merged, null, 2));
    console.log(`${file}: unioned ${missing.length} row(s) from origin that were missing locally`);
  } else {
    console.log(`${file}: local copy already a superset (${local.length} rows)`);
  }
}
