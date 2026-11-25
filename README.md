<p align="center"><img src="assets/banner.svg" alt="attic" width="100%"></p>

**Everything you've kept, finally findable.**

attic turns a folder of notes, transcripts, PDFs and media into one local, searchable memory. It ranks results by keyword and by meaning together, dates photos by when they were taken, and keeps everything in a single SQLite file on your machine.

## Quick start

Needs [Bun](https://bun.sh) 1.1 or newer. No accounts, no keys, nothing leaves your disk.

```sh
git clone https://github.com/numbercutter/attic && cd attic
bun src/cli.ts index examples/notes --db examples/attic.db
bun src/cli.ts search "lisbon flights tile museum" --db examples/attic.db
bun src/cli.ts on 2025-06-14 --db examples/attic.db
bun src/cli.ts serve --db examples/attic.db
```

The search above matches no single file word for word, so keyword mode finds nothing; hybrid mode ranks the three notes that mention Lisbon first. `on 2025-06-14` includes `DSC_0412.jpg`, dated from its EXIF capture time rather than its file date. `serve` opens a search box and a day view at http://127.0.0.1:4321.

To get an `attic` command on your path, run `bun link` in the repo.

## Usage

```sh
attic index ~/notes                       # walk a folder; re-run any time
attic search "rounding bug"               # hybrid: keyword and meaning, fused
attic search "rounding bug" --mode keyword
attic search "money owed" --mode semantic
attic search "garden*" --limit 5          # trailing * matches a prefix
attic on 2025-06-01                       # everything from that day
attic recent 20                           # newest 20 entries
attic serve --port 4321                   # local web UI, bound to 127.0.0.1
attic recent --db ./work.db               # any command takes --db
```

The database defaults to `~/.attic/attic.db`. Index as many folders into it as you like.

### Embedders

`attic index` embeds every file with the built-in hash embedder unless you choose another. Search uses whichever embedder the database was built with.

```sh
attic index ~/notes --embedder ollama                     # nomic-embed-text at OLLAMA_URL (default http://localhost:11434)
attic index ~/notes --embedder ollama:mxbai-embed-large
OPENAI_API_KEY=... attic index ~/notes --embedder openai  # text-embedding-3-small
```

`ATTIC_EMBEDDER` works in place of the flag. Switching embedders re-embeds the whole database on the next index; full-text data is kept.

### PDFs and photos

PDF text comes from `pdftotext` (part of poppler: `brew install poppler`, `apt install poppler-utils`) when it is on your path. Without it, PDFs are indexed by name and `attic index` says how many. Install it later and re-run `attic index`; those PDFs are read then.

JPEG files are dated from the EXIF `DateTimeOriginal` tag, read directly from the file's bytes.

As a library:

```ts
import { open, index, find, OllamaEmbedder } from "@numbercutter/attic";

const db = open("notes.db");
await index(db, "./notes", { embedder: new OllamaEmbedder("nomic-embed-text") });
for (const hit of await find(db, "fig tree", { mode: "hybrid" })) console.log(hit.path, hit.via, hit.snippet);
```

## How it works

- **Walk.** Every `.md .txt .json .srt .vtt .pdf` file is read as text. Subtitle files lose their cue numbers, timestamps and voice tags; JSON is flattened to its keys and string values. Images, audio and video (`.jpg .png .heic .mp3 .m4a .wav .mp4 .mov` and friends) are indexed by filename, folder and date.
- **Store.** One `files` table holds path, kind, mtime, size and day. An FTS5 table with the Porter stemmer holds folder, filename and body. A `chunks` table holds each file split into pieces of about 1,000 characters with one vector per piece, in the same database.
- **Stay current.** A file is re-read and re-embedded only when its mtime or size changed. Files that vanished from the folder are dropped from the index.
- **Rank.** Keyword mode uses `bm25` with filename matches weighted above body matches. Semantic mode scores every chunk against the query vector and keeps each file's best chunk, dropping files under 35% of the top score. Hybrid runs both and merges them with reciprocal rank fusion (`1 / (60 + rank)` summed per file); each result says whether it came from `keyword`, `semantic` or `both`.
- **Hash embedder.** Hashed words, word prefixes, character trigrams and word pairs in a 768-dimension vector. It needs nothing installed and catches partial matches and small misspellings; it does not know that two different words mean the same thing.
- **Date.** A file's day comes from EXIF capture time for JPEGs, then a `YYYY-MM-DD` (or `YYYYMMDD`) in its filename, then a `date:` line in Markdown front matter, then its modification time.
- **Serve.** `attic serve` is one HTML page and three JSON routes on `127.0.0.1`. It shows paths and snippets; it never serves file contents.

## Limits

- No OCR or speech-to-text. A photo or recording is findable only by its name, folder and date.
- With the default hash embedder, "semantic" means overlapping words and spellings, not meaning: "car" will not find "vehicle". Use Ollama or OpenAI embeddings for that.
- Vector search is a brute-force scan of every chunk. Fine for tens of thousands of files, slow for millions. Files are capped at 64 chunks each, so the tail of a very long file is keyword-only.
- The Ollama path was exercised against a stand-in HTTP server that speaks `/api/embed`, not a real model. The OpenAI path was not exercised. Neither retries.
- PDF text was exercised with a stand-in `pdftotext`, not poppler itself. Scanned PDFs with no text layer come out empty and fall back to name only.
- EXIF dates are read from JPEG only, not HEIC, PNG or video, and ignore the time-zone offset tags.
- Text files are read whole into memory; very large logs will be slow.
- Word files and email archives are skipped.
- Dates from mtime follow your machine's local time zone, and copying files can reset mtime.
- Removing a folder from disk removes it from the index only when you re-run `attic index` on its parent.
- `attic serve` has no login. It binds to 127.0.0.1 only; do not put it behind a public proxy.

Works with [partition](https://github.com/numbercutter/partition): index a shared or family archive with attic, then serve it to several people with per-person access.

<sub>A numbercutter instrument · MIT</sub>
