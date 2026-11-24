import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, basename, resolve, join, sep } from "node:path";

export const TEXT_EXTS = new Set([".md", ".txt", ".json", ".srt", ".vtt"]);
export const MEDIA_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".heic", ".webp", ".tiff",
  ".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac",
  ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi",
]);

export type Hit = { path: string; day: string; kind: string; snippet: string; score: number };
export type Entry = { path: string; day: string; kind: string; title: string };
export type IndexReport = { scanned: number; added: number; updated: number; unchanged: number; removed: number };

export function open(dbPath: string): Database {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    day TEXT NOT NULL,
    title TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS files_day ON files(day)");
  db.run("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path, title, body, tokenize = 'porter unicode61')");
  return db;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (TEXT_EXTS.has(ext) || MEDIA_EXTS.has(ext)) out.push(full);
    }
  }
  return out;
}

function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayFor(path: string, body: string, mtimeMs: number): string {
  const fromName = basename(path).match(/(\d{4})-?(\d{2})-?(\d{2})/);
  if (fromName && validDay(`${fromName[1]}-${fromName[2]}-${fromName[3]}`)) return `${fromName[1]}-${fromName[2]}-${fromName[3]}`;
  const front = body.match(/^---\s*\n[\s\S]*?^date:\s*["']?(\d{4}-\d{2}-\d{2})/m);
  if (front && validDay(front[1])) return front[1];
  return localDay(mtimeMs);
}

export function validDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

function stripCaptions(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t || t === "WEBVTT" || /^\d+$/.test(t) || t.includes("-->")) return false;
      if (/^(NOTE|STYLE|REGION)\b/.test(t)) return false;
      return true;
    })
    .map((line) => line.replace(/<[^>]+>/g, "").trim())
    .join("\n");
}

function jsonText(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "boolean") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) jsonText(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      jsonText(v, out);
    }
  return out;
}

async function extract(path: string, ext: string): Promise<string> {
  const raw = await Bun.file(path).text();
  if (ext === ".srt" || ext === ".vtt") return stripCaptions(raw);
  if (ext === ".json") {
    try {
      return jsonText(JSON.parse(raw)).join("\n");
    } catch {
      return raw;
    }
  }
  return raw;
}


export async function index(db: Database, dir: string): Promise<IndexReport> {
  const root = resolve(dir);
  const report: IndexReport = { scanned: 0, added: 0, updated: 0, unchanged: 0, removed: 0 };
  const existing = db.query<{ id: number; mtime: number; size: number }, [string]>("SELECT id, mtime, size FROM files WHERE path = ?");
  const upsert = db.query<{ id: number }, [string, string, number, number, string, string]>(
    `INSERT INTO files (path, kind, mtime, size, day, title) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, mtime = excluded.mtime, size = excluded.size, day = excluded.day, title = excluded.title
     RETURNING id`,
  );
  const dropDoc = db.query("DELETE FROM docs WHERE rowid = ?");
  const putDoc = db.query("INSERT INTO docs (rowid, path, title, body) VALUES (?, ?, ?, ?)");
  const seen = new Set<string>();

  for (const path of walk(root)) {
    report.scanned++;
    seen.add(path);
    const st = statSync(path);
    const mtime = Math.floor(st.mtimeMs);
    const prior = existing.get(path);
    if (prior && prior.mtime === mtime && prior.size === st.size) {
      report.unchanged++;
      continue;
    }
    const ext = extname(path).toLowerCase();
    const media = MEDIA_EXTS.has(ext);
    const text = media ? "" : await extract(path, ext);
    const day = dayFor(path, text, st.mtimeMs);
    const folder = dirname(path).slice(root.length + 1);
    const title = basename(path);
    const body = media ? `${title} · ${folder || "."} · ${day}` : text;
    const kind = media ? "media" : ext.slice(1);
    db.transaction(() => {
      const { id } = upsert.get(path, kind, mtime, st.size, day, title)!;
      dropDoc.run(id);
      putDoc.run(id, folder, title, body);
    })();
    prior ? report.updated++ : report.added++;
  }

  const under = db.query<{ id: number; path: string }, [string]>("SELECT id, path FROM files WHERE path LIKE ? ESCAPE '\\'");
  const prefix = root.replace(/[\\%_]/g, (c) => `\\${c}`) + sep + "%";
  const gone = under.all(prefix).filter((r) => !seen.has(r.path));
  db.transaction(() => {
    for (const r of gone) {
      dropDoc.run(r.id);
      db.query("DELETE FROM files WHERE id = ?").run(r.id);
    }
  })();
  report.removed = gone.length;
  return report;
}

export function toMatch(query: string): string {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .map((t) => (t.endsWith("*") ? `"${t.slice(0, -1)}"*` : `"${t}"`))
    .join(" ");
}

export function search(db: Database, query: string, limit = 10, mark: [string, string] = ["[", "]"]): Hit[] {
  const match = toMatch(query);
  if (!match) return [];
  return db
    .query<Hit, [string, string, string, number]>(
      `SELECT f.path, f.day, f.kind,
              snippet(docs, -1, ?, ?, '…', 14) AS snippet,
              bm25(docs, 1.5, 3.0, 1.0) AS score
       FROM docs JOIN files f ON f.id = docs.rowid
       WHERE docs MATCH ?
       ORDER BY score
       LIMIT ?`,
    )
    .all(mark[0], mark[1], match, limit);
}

export function on(db: Database, day: string): Entry[] {
  return db.query<Entry, [string]>("SELECT path, day, kind, title FROM files WHERE day = ? ORDER BY kind, path").all(day);
}

export function recent(db: Database, n = 10): Entry[] {
  return db.query<Entry, [number]>("SELECT path, day, kind, title FROM files ORDER BY day DESC, mtime DESC, path LIMIT ?").all(n);
}
