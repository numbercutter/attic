import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, basename, resolve, join, sep } from "node:path";
import { HashEmbedder, embedderFor, type Embedder } from "./embed.ts";

export { HashEmbedder, OllamaEmbedder, OpenAIEmbedder, embedderFor, type Embedder } from "./embed.ts";

export const TEXT_EXTS = new Set([".md", ".txt", ".json", ".srt", ".vtt", ".pdf"]);
export const MEDIA_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".heic", ".webp", ".tiff",
  ".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac",
  ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi",
]);

export type Mode = "hybrid" | "keyword" | "semantic";
export type Hit = { path: string; day: string; kind: string; snippet: string; score: number; via: "keyword" | "semantic" | "both" };
export type Entry = { path: string; day: string; kind: string; title: string };
export type IndexReport = {
  scanned: number; added: number; updated: number; unchanged: number; removed: number;
  embedded: number; embedder: string; pdfNameOnly: number;
};

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
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run(`CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    vector BLOB NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id)");
  return db;
}

export function storedEmbedder(db: Database): string | null {
  return db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'embedder'").get()?.value ?? null;
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

function dayFor(path: string, body: string, mtimeMs: number, captured: string | null): string {
  if (captured) return captured;
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

export function exifDate(bytes: Uint8Array): string | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const len = view.getUint16(at + 2);
    if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(at + 4, at + 10)) === "Exif\0\0") {
      return tiffDate(view, at + 10, Math.min(bytes.length, at + 2 + len));
    }
    at += 2 + len;
  }
  return null;
}

function tiffDate(view: DataView, base: number, end: number): string | null {
  if (base + 8 > end) return null;
  const order = view.getUint16(base);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const le = order === 0x4949;
  const u16 = (o: number) => view.getUint16(base + o, le);
  const u32 = (o: number) => view.getUint32(base + o, le);
  const tags = (ifd: number) => {
    const out = new Map<number, { type: number; count: number; value: number }>();
    if (ifd <= 0 || base + ifd + 2 > end) return out;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (base + e + 12 > end) break;
      out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), value: u32(e + 8) });
    }
    return out;
  };
  const ascii = (t?: { type: number; count: number; value: number }) => {
    if (!t || t.type !== 2 || t.count < 19 || base + t.value + 19 > end) return null;
    let s = "";
    for (let i = 0; i < 19; i++) s += String.fromCharCode(view.getUint8(base + t.value + i));
    const m = s.match(/^(\d{4}):(\d{2}):(\d{2})/);
    return m && validDay(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };
  const ifd0 = tags(u32(4));
  const exif = tags(ifd0.get(0x8769)?.value ?? 0);
  return ascii(exif.get(0x9003)) ?? ascii(exif.get(0x9004)) ?? ascii(ifd0.get(0x0132));
}

async function captureDay(path: string, ext: string): Promise<string | null> {
  if (ext !== ".jpg" && ext !== ".jpeg") return null;
  return exifDate(new Uint8Array(await Bun.file(path).slice(0, 262144).arrayBuffer()));
}

export const pdftotext = Bun.which("pdftotext");

async function pdfText(path: string): Promise<string | null> {
  if (!pdftotext) return null;
  const proc = Bun.spawn([pdftotext, "-enc", "UTF-8", "-q", path, "-"], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? text : "";
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


function pieces(title: string, body: string, max = 1000, cap = 64): string[] {
  const out: string[] = [];
  let cur = title;
  for (const para of body.replace(/\r/g, "").split(/\n\s*\n/)) {
    const p = para.replace(/\s+/g, " ").trim();
    if (!p) continue;
    if (cur.length + p.length + 1 > max && cur.length > title.length) {
      out.push(cur);
      if (out.length >= cap) return out;
      cur = title;
    }
    cur += `\n${p.slice(0, max)}`;
  }
  out.push(cur);
  return out.slice(0, cap);
}

export type IndexOptions = { embedder?: Embedder; onEmbed?: (done: number, total: number) => void };

export async function index(db: Database, dir: string, opts: IndexOptions = {}): Promise<IndexReport> {
  const root = resolve(dir);
  const stored = storedEmbedder(db);
  const embedder = opts.embedder ?? (stored ? embedderFor(stored) : new HashEmbedder());
  if (stored !== embedder.name) {
    db.transaction(() => {
      db.run("DELETE FROM chunks");
      db.query("INSERT INTO meta (key, value) VALUES ('embedder', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(embedder.name);
    })();
  }
  const report: IndexReport = { scanned: 0, added: 0, updated: 0, unchanged: 0, removed: 0, embedded: 0, embedder: embedder.name, pdfNameOnly: 0 };
  const existing = db.query<{ id: number; mtime: number; size: number; kind: string }, [string]>("SELECT id, mtime, size, kind FROM files WHERE path = ?");
  const upsert = db.query<{ id: number }, [string, string, number, number, string, string]>(
    `INSERT INTO files (path, kind, mtime, size, day, title) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, mtime = excluded.mtime, size = excluded.size, day = excluded.day, title = excluded.title
     RETURNING id`,
  );
  const dropDoc = db.query("DELETE FROM docs WHERE rowid = ?");
  const dropChunks = db.query("DELETE FROM chunks WHERE file_id = ?");
  const putDoc = db.query("INSERT INTO docs (rowid, path, title, body) VALUES (?, ?, ?, ?)");
  const seen = new Set<string>();

  for (const path of walk(root)) {
    report.scanned++;
    seen.add(path);
    const st = statSync(path);
    const mtime = Math.floor(st.mtimeMs);
    const prior = existing.get(path);
    const retryPdf = prior?.kind === "pdf:name" && !!pdftotext;
    if (prior && prior.mtime === mtime && prior.size === st.size && !retryPdf) {
      if (prior.kind === "pdf:name") report.pdfNameOnly++;
      report.unchanged++;
      continue;
    }
    const ext = extname(path).toLowerCase();
    const folder = dirname(path).slice(root.length + 1);
    const title = basename(path);
    let kind = MEDIA_EXTS.has(ext) ? "media" : ext.slice(1);
    let text = "";
    if (ext === ".pdf") {
      const pdf = await pdfText(path);
      if (pdf === null) {
        kind = "pdf:name";
        report.pdfNameOnly++;
      } else text = pdf;
    } else if (kind !== "media") text = await extract(path, ext);
    const day = dayFor(path, text, st.mtimeMs, await captureDay(path, ext));
    const body = text.trim() ? text : `${title} · ${folder || "."} · ${day}`;
    db.transaction(() => {
      const { id } = upsert.get(path, kind, mtime, st.size, day, title)!;
      dropDoc.run(id);
      dropChunks.run(id);
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
      dropChunks.run(r.id);
      db.query("DELETE FROM files WHERE id = ?").run(r.id);
    }
  })();
  report.removed = gone.length;

  const todo = db
    .query<{ id: number; title: string; body: string }, []>(
      `SELECT f.id, d.title, d.body FROM files f JOIN docs d ON d.rowid = f.id
       WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.file_id = f.id)`,
    )
    .all();
  const putChunk = db.query("INSERT INTO chunks (file_id, seq, text, vector) VALUES (?, ?, ?, ?)");
  const queue = todo.flatMap((f) => pieces(f.title, f.body).map((text, seq) => ({ id: f.id, seq, text })));
  for (let i = 0; i < queue.length; i += 32) {
    const batch = queue.slice(i, i + 32);
    const vectors = await embedder.embed(batch.map((b) => b.text));
    db.transaction(() => batch.forEach((b, j) => putChunk.run(b.id, b.seq, b.text, new Uint8Array(vectors[j].buffer))))();
    opts.onEmbed?.(Math.min(i + 32, queue.length), queue.length);
  }
  report.embedded = todo.length;
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
              -bm25(docs, 1.5, 3.0, 1.0) AS score,
              'keyword' AS via
       FROM docs JOIN files f ON f.id = docs.rowid
       WHERE docs MATCH ?
       ORDER BY score DESC
       LIMIT ?`,
    )
    .all(mark[0], mark[1], match, limit);
}

function highlight(text: string, query: string, mark: [string, string]): string {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2);
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w.slice(0, 4));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at - 60);
  let out = (start > 0 ? "…" : "") + flat.slice(start, start + 160) + (flat.length > start + 160 ? "…" : "");
  if (words.length) {
    const re = new RegExp(`\\b(${words.map((w) => w.slice(0, 4).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[\\p{L}\\p{N}]*`, "giu");
    out = out.replace(re, (m) => `${mark[0]}${m}${mark[1]}`);
  }
  return out;
}

export async function semantic(db: Database, query: string, limit = 10, mark: [string, string] = ["[", "]"]): Promise<Hit[]> {
  const name = storedEmbedder(db);
  if (!name || !query.trim()) return [];
  const [q] = await embedderFor(name).embed([query]);
  const best = new Map<number, { score: number; text: string }>();
  for (const row of db.query<{ file_id: number; text: string; vector: Uint8Array }, []>("SELECT file_id, text, vector FROM chunks").iterate()) {
    const v = new Float32Array(row.vector.slice().buffer);
    if (v.length !== q.length) throw new Error(`index vectors have ${v.length} dimensions, query has ${q.length}; re-run attic index`);
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * q[i];
    const prev = best.get(row.file_id);
    if (!prev || s > prev.score) best.set(row.file_id, { score: s, text: row.text });
  }
  const ranked = [...best.entries()].sort((a, b) => b[1].score - a[1].score);
  const floor = Math.max(0, (ranked[0]?.[1].score ?? 0) * 0.35);
  const top = ranked.filter(([, b]) => b.score > floor).slice(0, limit);
  const file = db.query<{ path: string; day: string; kind: string }, [number]>("SELECT path, day, kind FROM files WHERE id = ?");
  return top.map(([id, b]) => {
    const f = file.get(id)!;
    const body = b.text.includes("\n") ? b.text.slice(b.text.indexOf("\n") + 1) : b.text;
    return { ...f, snippet: highlight(body, query, mark), score: b.score, via: "semantic" as const };
  });
}

export async function find(db: Database, query: string, opts: { mode?: Mode; limit?: number; mark?: [string, string] } = {}): Promise<Hit[]> {
  const limit = opts.limit ?? 10;
  const mark = opts.mark ?? ["[", "]"];
  const mode = opts.mode ?? "hybrid";
  if (mode === "keyword") return search(db, query, limit, mark);
  if (mode === "semantic") return semantic(db, query, limit, mark);
  const depth = Math.max(limit * 4, 40);
  const legs = [search(db, query, depth, mark), await semantic(db, query, depth, mark)];
  const fused = new Map<string, Hit>();
  for (const leg of legs)
    leg.forEach((h, rank) => {
      const rrf = 1 / (60 + rank + 1);
      const prev = fused.get(h.path);
      if (prev) fused.set(h.path, { ...prev, score: prev.score + rrf, via: "both" });
      else fused.set(h.path, { ...h, score: rrf });
    });
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export function on(db: Database, day: string): Entry[] {
  return db.query<Entry, [string]>("SELECT path, day, kind, title FROM files WHERE day = ? ORDER BY kind, path").all(day);
}

export function recent(db: Database, n = 10): Entry[] {
  return db.query<Entry, [number]>("SELECT path, day, kind, title FROM files ORDER BY day DESC, mtime DESC, path LIMIT ?").all(n);
}
