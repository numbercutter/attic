#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { existsSync, statSync } from "node:fs";
import { open, index, find, on, recent, validDay, embedderFor, pdftotext, type Mode } from "./attic.ts";
import { serve } from "./serve.ts";

const USAGE = `attic — everything you've kept, finally findable

usage:
  attic index <dir>          index a folder (only changed files are re-read)
  attic search "<query>"     ranked search  [--limit n] [--mode hybrid|keyword|semantic]
  attic on <YYYY-MM-DD>      everything from that day
  attic recent [n]           newest n entries (default 10)
  attic serve                local web UI on http://127.0.0.1:4321  [--port n]

options:
  --db <path>                database file (default ~/.attic/attic.db)
  --embedder <name>          for index: hash (default, offline), ollama[:model], openai[:model]
                             (ATTIC_EMBEDDER also works; OLLAMA_URL, OPENAI_API_KEY)`;

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined) fail(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}
function fail(msg: string): never {
  console.error(`attic: ${msg}`);
  process.exit(1);
}

const dbPath = flag("--db") ?? join(homedir(), ".attic", "attic.db");
const limit = Number(flag("--limit") ?? 10);
const mode = (flag("--mode") ?? "hybrid") as Mode;
if (!["hybrid", "keyword", "semantic"].includes(mode)) fail(`--mode must be hybrid, keyword or semantic`);
const embedderSpec = flag("--embedder") ?? process.env.ATTIC_EMBEDDER;
const port = Number(flag("--port") ?? 4321);
const [cmd, ...rest] = args;
const tty = process.stdout.isTTY;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const show = (p: string) => {
  const r = relative(process.cwd(), p);
  return r.startsWith("..") ? p : r;
};

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(USAGE);
  process.exit(cmd ? 0 : 1);
}

const db = open(dbPath);

switch (cmd) {
  case "index": {
    const dir = rest[0] ?? fail("index needs a folder");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`not a folder: ${dir}`);
    const t = performance.now();
    let embedder;
    try {
      embedder = embedderSpec ? embedderFor(embedderSpec === "ollama" ? "ollama:nomic-embed-text" : embedderSpec) : undefined;
    } catch (err) {
      fail((err as Error).message);
    }
    const r = await index(db, dir, { embedder }).catch((err) => fail(`embedding failed: ${(err as Error).message}`));
    const ms = Math.round(performance.now() - t);
    console.log(`${r.scanned} files · ${r.added} added · ${r.updated} updated · ${r.unchanged} unchanged · ${r.removed} removed · ${ms}ms`);
    console.log(c("2", `${r.embedded} embedded with ${r.embedder}`));
    if (r.pdfNameOnly)
      console.log(c("2", `note: ${r.pdfNameOnly} PDF${r.pdfNameOnly === 1 ? "" : "s"} indexed by name only; install pdftotext (poppler) and re-run to read ${r.pdfNameOnly === 1 ? "its" : "their"} text`));
    break;
  }
  case "search": {
    const q = rest.join(" ").trim() || fail("search needs a query");
    const hits = await find(db, q, { mode, limit, mark: tty ? ["\x1b[1;33m", "\x1b[0m"] : ["[", "]"] }).catch((err) => fail((err as Error).message));
    if (!hits.length) console.log("no matches");
    for (const h of hits) {
      const score = mode === "hybrid" ? `${h.score.toFixed(4)} ${h.via}` : h.score.toFixed(mode === "semantic" ? 3 : 2);
      console.log(`${c("1", show(h.path))}  ${c("2", `${h.day} · ${h.kind} · ${score}`)}`);
      console.log(`  ${h.snippet.replace(/\s+/g, " ").trim()}\n`);
    }
    break;
  }
  case "on": {
    const day = rest[0] ?? fail("on needs a date like 2025-06-01");
    if (!validDay(day)) fail(`not a date: ${day}`);
    const rows = on(db, day);
    if (!rows.length) console.log(`nothing from ${day}`);
    for (const r of rows) console.log(`${c("2", r.kind.padEnd(5))}  ${show(r.path)}`);
    break;
  }
  case "recent": {
    const n = Number(rest[0] ?? 10);
    if (!Number.isInteger(n) || n < 1) fail("recent takes a positive number");
    for (const r of recent(db, n)) console.log(`${c("2", r.day)}  ${c("2", r.kind.padEnd(5))}  ${show(r.path)}`);
    break;
  }
  case "serve": {
    if (!Number.isInteger(port) || port < 1) fail("--port takes a number");
    const server = serve(db, port);
    console.log(`attic on http://${server.hostname}:${server.port}  (local only, ctrl-c to stop)`);
    if (!pdftotext) console.log(c("2", "pdftotext not found: PDFs are searchable by name only"));
    break;
  }
  default:
    fail(`unknown command "${cmd}"\n\n${USAGE}`);
}
