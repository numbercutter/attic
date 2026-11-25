export interface Embedder {
  readonly name: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const STOP = new Set("a an and are as at be by for from has have in is it its of on or that the this to was were will with what which who we you i me my".split(" "));

export function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export class HashEmbedder implements Embedder {
  readonly name: string;
  constructor(readonly dim = 768) {
    this.name = `hash-${dim}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const add = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      v[h % this.dim] += h & 0x80000000 ? -weight : weight;
    };
    const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w));
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      add(`w:${w}`, 1);
      if (w.length > 4) add(`p:${w.slice(0, 5)}`, 0.5);
      const padded = `^${w}$`;
      for (let j = 0; j + 3 <= padded.length; j++) add(`t:${padded.slice(j, j + 3)}`, 0.25);
      if (i > 0) add(`b:${words[i - 1]} ${w}`, 0.5);
    }
    return normalize(v);
  }
}

export class OllamaEmbedder implements Embedder {
  readonly name: string;
  constructor(
    readonly model = "nomic-embed-text",
    private readonly url = process.env.OLLAMA_URL ?? "http://localhost:11434",
  ) {
    this.name = `ollama:${model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const url = `${this.url.replace(/\/$/, "")}/api/embed`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    }).catch(() => {
      throw new Error(`cannot reach Ollama at ${this.url}`);
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { embeddings: number[][] };
    return json.embeddings.map((e) => normalize(Float32Array.from(e)));
  }
}

export class OpenAIEmbedder implements Embedder {
  readonly name: string;
  constructor(
    readonly model = "text-embedding-3-small",
    private readonly apiKey = process.env.OPENAI_API_KEY ?? "",
  ) {
    if (!apiKey) throw new Error("the openai embedder needs OPENAI_API_KEY");
    this.name = `openai:${model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return json.data.sort((a, b) => a.index - b.index).map((d) => normalize(Float32Array.from(d.embedding)));
  }
}

export function embedderFor(spec: string): Embedder {
  const [kind, ...rest] = spec.split(":");
  const model = rest.join(":");
  if (kind === "ollama") return new OllamaEmbedder(model || undefined);
  if (kind === "openai") return new OpenAIEmbedder(model || undefined);
  if (kind === "hash") return new HashEmbedder();
  const m = spec.match(/^hash-(\d+)$/);
  if (m) return new HashEmbedder(Number(m[1]));
  throw new Error(`unknown embedder "${spec}" (use hash, ollama[:model] or openai[:model])`);
}
