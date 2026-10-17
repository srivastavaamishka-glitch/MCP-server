import { createHash, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { fileURLToPath } from "node:url";
import express, { type Request } from "express";
import type { AuthConfig } from "./executor.js";
import { mockApi } from "./mock-api.js";
import { Engine, mountMcpHttp, type EngineOptions } from "./server.js";
import { open, seal } from "./token.js";

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const allowPrivate = process.env.ALLOW_PRIVATE ? process.env.ALLOW_PRIVATE === "1" : process.env.NODE_ENV !== "production";
const REPO = process.env.REPO_SLUG ?? "<your-github-user>/anything-to-mcp";
const SECRET = process.env.SESSION_SECRET;

// ---- SSRF policy: hosted mode fetches user-supplied URLs, so refuse private/loopback/link-local targets. ----
const blocked = new BlockList();
([["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const).forEach(([n, p]) => blocked.addSubnet(n, p, "ipv4"));
([["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10]] as const).forEach(([n, p]) => blocked.addSubnet(n, p, "ipv6"));

async function assertPublicUrl(u: string) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) URLs are allowed");
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  for (const { address } of addrs) {
    const a = address.replace(/^::ffff:/, "");
    if (blocked.check(a, isIP(a) === 6 ? "ipv6" : "ipv4")) throw new Error(`Refusing to connect to a private address (${host})`);
  }
}

async function fetchSpecText(url: string, hops = 3): Promise<string> {
  await assertPublicUrl(url);
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const next = r.headers.get("location");
  if (r.status >= 300 && r.status < 400 && next && hops) return fetchSpecText(new URL(next, url).href, hops - 1);
  if (!r.ok) throw new Error(`Fetching spec failed: HTTP ${r.status}`);
  const t = await r.text();
  if (t.length > 5_000_000) throw new Error("Spec is larger than 5 MB");
  return t;
}

// ---- Config (what a user submits) -> engine options ----
interface Config { spec: string; readOnly: boolean; baseUrl?: string; auth: AuthConfig }
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const isUrlSpec = (s: string) => /^https?:\/\/\S+$/.test(s);

async function readConfig(b: any = {}): Promise<Config> {
  const spec = str(b.spec);
  if (!spec) throw new Error("Provide an OpenAPI URL or paste the spec (YAML or JSON).");
  const baseUrl = str(b.baseUrl);
  if (baseUrl) await assertPublicUrl(baseUrl);
  const a = b.auth ?? {};
  return { spec, readOnly: !!b.readOnly, baseUrl, auth: { bearer: str(a.bearer), apiKey: str(a.apiKey), apiKeyName: str(a.apiKeyName), apiKeyIn: a.apiKeyIn === "query" ? "query" : "header" } };
}

const optsFromConfig = (c: Config): EngineOptions => ({
  source: c.spec, readOnly: c.readOnly, baseUrl: c.baseUrl, auth: c.auth,
  loader: isUrlSpec(c.spec) ? () => fetchSpecText(c.spec) : undefined,
  pollMs: isUrlSpec(c.spec) ? 30_000 : undefined,
  external: false, // untrusted specs must not pull in arbitrary files/URLs via $ref
  guard: assertPublicUrl, redirect: "manual",
});

export interface AppOptions {
  /** Serverless-friendly: no in-memory sessions, hosted endpoint is a stateless POST /mcp, no SSE log. Used on Vercel. */
  stateless?: boolean;
}

export function createApp({ stateless = false }: AppOptions = {}) {
  // Stateful mode: one live Engine per generated server (UI + hosted endpoint share it).
  interface Session { engine: Engine; stop: () => void; specRef: string | null }
  const sessions = new Map<string, Session>();
  const MAX_SESSIONS = 100;

  // Stateless mode: engines are rebuilt from the config on demand and cached briefly per instance.
  const cache = new Map<string, { engine: Engine; at: number }>();
  async function statelessEngine(cfg: Config): Promise<Engine> {
    const k = createHash("sha256").update(JSON.stringify(cfg)).digest("hex");
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < 60_000) return hit.engine; // spec edits are picked up within a minute
    const engine = new Engine({ ...optsFromConfig(cfg), pollMs: undefined });
    await engine.load();
    cache.set(k, { engine, at: Date.now() });
    if (cache.size > 50) cache.delete(cache.keys().next().value!);
    return engine;
  }

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "5mb" }));

  const hits = new Map<string, number[]>();
  setInterval(() => hits.clear(), 5 * 60_000).unref();
  app.use("/api", (req, res, next) => {
    const now = Date.now(), recent = (hits.get(req.ip ?? "?") ?? []).filter((t) => now - t < 60_000);
    hits.set(req.ip ?? "?", [...recent, now]);
    recent.length >= 120 ? void res.status(429).json({ error: "Too many requests, slow down." }) : next();
  });

  const origin = (req: Request) => `${req.protocol}://${req.get("host")}`;

  function describe(engine: Engine, specRef: string | null, handle: string | null, req: Request) {
    const { parsed } = engine, o = origin(req);
    const flags = `${engine.opts.readOnly ? " --read-only" : ""}${engine.opts.baseUrl ? ` --base-url ${engine.opts.baseUrl}` : ""}`;
    const env = engine.opts.auth?.bearer ? "API_BEARER_TOKEN=<your-token> " : engine.opts.auth?.apiKey ? "API_KEY=<your-key> " : "";
    const spec = specRef ?? "<path-to-openapi.yaml>";
    const name = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return {
      title: parsed.title, version: parsed.version, baseUrl: engine.baseUrl, readOnly: !!engine.opts.readOnly, skipped: parsed.skipped,
      stateless,
      tools: parsed.tools.map((t) => ({ name: t.name, description: t.description, method: t.http.method, path: t.http.path, readOnlyHint: t.annotations.readOnlyHint, inputSchema: t.inputSchema })),
      connect: {
        streamableHttp: handle ? `${o}/h/${handle}/mcp` : null,
        sse: handle && !stateless ? `${o}/h/${handle}/sse` : null,
        claudeCode: handle ? `claude mcp add --transport http ${name} ${o}/h/${handle}/mcp` : null,
        npx: `${env}npx -y github:${REPO} --spec ${spec}${flags}`,
        docker: `docker run -i --rm ${env && `-e ${env}`}anything-to-mcp --spec ${spec}${flags}`,
      },
    };
  }

  app.get("/api/config", (_req, res) => res.json({ demoToken: "demo-token", allowPrivate, stateless }));

  app.post("/api/generate", async (req, res) => {
    try {
      const cfg = await readConfig(req.body);
      const specRef = isUrlSpec(cfg.spec) ? cfg.spec : null;

      if (stateless) {
        const engine = await statelessEngine(cfg);
        let token: string | null = null, hostedNote: string | undefined;
        if (!specRef) hostedNote = "Hosted endpoints need a spec URL (a pasted spec is too large to carry in the endpoint URL). Use the run commands, or host the spec at a URL.";
        else if ((cfg.auth.bearer || cfg.auth.apiKey) && !SECRET) hostedNote = "Set SESSION_SECRET on the server to host an endpoint that carries credentials.";
        else token = seal(cfg, SECRET);
        return void res.json({ ...describe(engine, specRef, token, req), hostedNote });
      }

      const opts = optsFromConfig(cfg);
      const existing = sessions.get(String(req.body.id));
      let id: string, s: Session, diff;
      if (existing) {
        // Reconfigure in place so already-connected MCP clients receive notifications/tools/list_changed.
        id = String(req.body.id); s = existing;
        const prev = { ...s.engine.opts };
        s.stop();
        Object.assign(s.engine.opts, opts);
        try { diff = await s.engine.load(); } catch (e) { Object.assign(s.engine.opts, prev); s.stop = s.engine.watch(); throw e; }
        s.stop = s.engine.watch();
        s.specRef = specRef;
      } else {
        const engine = new Engine(opts);
        diff = await engine.load();
        id = randomUUID();
        s = { engine, stop: engine.watch(), specRef };
        sessions.set(id, s);
        if (sessions.size > MAX_SESSIONS) { const [oldId, old] = sessions.entries().next().value!; old.stop(); sessions.delete(oldId); }
      }
      res.json({ id, ...describe(s.engine, s.specRef, id, req), diff });
    } catch (e: any) {
      res.status(400).json({ error: e.message ?? String(e) });
    }
  });

  app.get("/api/session/:id", (req, res) => {
    const s = sessions.get(req.params.id);
    s ? res.json({ id: req.params.id, ...describe(s.engine, s.specRef, req.params.id, req) }) : res.status(404).json({ error: "Unknown session" });
  });

  app.post("/api/call", async (req, res) => {
    try {
      if (stateless) return void res.json(await (await statelessEngine(await readConfig(req.body.config))).call(String(req.body.tool), req.body.args));
      const s = sessions.get(String(req.body.id));
      if (!s) return void res.status(404).json({ error: "Unknown session" });
      res.json(await s.engine.call(String(req.body.tool), req.body.args));
    } catch (e: any) {
      res.status(400).json({ error: e.message ?? String(e) });
    }
  });

  if (!stateless) {
    // Live feed: tool calls (from the UI *and* from any MCP client on the hosted endpoint) plus spec changes.
    app.get("/api/events/:id", (req, res) => {
      const s = sessions.get(req.params.id);
      if (!s) return void res.status(404).end();
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const send = (event: string) => (data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const [onCall, onChange] = [send("call"), send("change")];
      s.engine.on("call", onCall).on("change", onChange);
      const hb = setInterval(() => res.write(": hb\n\n"), 25_000);
      req.on("close", () => { clearInterval(hb); s.engine.off("call", onCall).off("change", onChange); });
    });
  }

  // Hosted MCP endpoints: /h/:id/mcp (+ /sse when stateful). The unguessable id (or sealed token) is the capability.
  mountMcpHttp(
    app,
    stateless
      ? async (req) => { try { return await statelessEngine(open<Config>(req.params.id, SECRET)); } catch { return undefined; } }
      : (req) => sessions.get(req.params.id)?.engine,
    "/h/:id",
    stateless,
  );

  // Demo assets: two copies of the mock REST API (open, and bearer-protected with token "demo-token").
  // The demo spec itself is static: public/demo/openapi.yaml.
  app.use("/demo-api", mockApi());
  app.use("/demo-api-auth", mockApi("demo-token"));
  app.get("/health", (_req, res) => void res.json({ ok: true, stateless, sessions: sessions.size }));
  app.use(express.static(root("public")));
  return app;
}
