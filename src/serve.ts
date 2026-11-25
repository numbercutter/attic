import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { find, on, recent, validDay, type Mode } from "./attic.ts";

const MARK: [string, string] = ["\u0001", "\u0002"];
const home = homedir();
const tidy = (p: string) => (p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);

export function serve(db: Database, port = 4321) {
  const page = Bun.file(new URL("./ui.html", import.meta.url));
  const near = (sql: string) => db.query<{ day: string | null }, [string]>(sql);
  const before = near("SELECT max(day) AS day FROM files WHERE day < ?");
  const after = near("SELECT min(day) AS day FROM files WHERE day > ?");

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const q = url.searchParams;
      try {
        if (url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
        if (url.pathname === "/api/search") {
          const mode = (["hybrid", "keyword", "semantic"].includes(q.get("mode") ?? "") ? q.get("mode") : "hybrid") as Mode;
          const limit = Math.min(Math.max(Number(q.get("limit")) || 20, 1), 100);
          const hits = await find(db, q.get("q") ?? "", { mode, limit, mark: MARK });
          return Response.json(hits.map((h) => ({ ...h, path: tidy(h.path) })));
        }
        if (url.pathname === "/api/day") {
          const day = q.get("d") ?? "";
          if (!validDay(day)) return Response.json({ error: "not a date" }, { status: 400 });
          return Response.json({
            day,
            prev: before.get(day)?.day ?? null,
            next: after.get(day)?.day ?? null,
            entries: on(db, day).map((e) => ({ ...e, path: tidy(e.path) })),
          });
        }
        if (url.pathname === "/api/recent") return Response.json(recent(db, 1)[0]?.day ?? null);
        return new Response("not found", { status: 404 });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 500 });
      }
    },
  });
}
