import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { unwatchFile, watchFile } from "node:fs";
import type { Express, Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { execute, type AuthConfig, type ToolResult } from "./executor.js";
import { diffTools, isInline, parseSpec, type ParsedSpec, type ToolDiff } from "./parser.js";

export interface EngineOptions {
  /** File path, http(s) URL, or inline YAML/JSON. */
  source: string;
  /** Overrides how the spec text is fetched (hosted mode uses a guarded fetcher). */
  loader?: () => Promise<string>;
  readOnly?: boolean;
  /** Overrides `servers[0].url` from the spec. */
  baseUrl?: string;
  auth?: AuthConfig;
  /** Poll interval for URL sources / loaders. File sources are watched instead. */
  pollMs?: number;
  external?: boolean;
  /** Called with the target base URL before every request (SSRF policy in hosted mode). */
  guard?: (url: string) => Promise<void>;
  redirect?: "follow" | "manual";
}

export interface CallLog { ts: number; tool: string; args: unknown; ms: number; isError: boolean; preview: string }

/**
 * Holds the compiled tools in memory and swaps them atomically on reload.
 * Events: "change" (ToolDiff) after a successful reload with differences, "call" (CallLog), "reload-error" (Error).
 */
export class Engine extends EventEmitter {
  parsed!: ParsedSpec;
  constructor(public opts: EngineOptions) { super(); }

  get baseUrl() { return this.opts.baseUrl || this.parsed.baseUrl; }

  /** Parse first, swap second: a broken spec edit never takes down the tools that were working. */
  async load(): Promise<ToolDiff> {
    const src = this.opts.loader ? await this.opts.loader() : this.opts.source;
    const specUrl = /^https?:\/\//.test(this.opts.source) ? this.opts.source : undefined;
    const next = await parseSpec(src, { readOnly: this.opts.readOnly, external: this.opts.external, specUrl });
    const diff = diffTools(this.parsed?.tools ?? [], next.tools);
    this.parsed = next;
    if (diff.added.length + diff.removed.length + diff.changed.length) this.emit("change", diff);
    return diff;
  }

  watch(): () => void {
    const s = this.opts.source;
    const reload = () => this.load().catch((e) => { console.error(`[reload] kept previous tools: ${e.message}`); this.emit("reload-error", e); });
    if (!this.opts.loader && !isInline(s) && !/^https?:\/\//.test(s)) {
      watchFile(s, { interval: 500 }, (cur, prev) => cur.mtimeMs !== prev.mtimeMs && reload());
      return () => unwatchFile(s);
    }
    if (!this.opts.pollMs) return () => {};
    const t = setInterval(reload, this.opts.pollMs);
    t.unref();
    return () => clearInterval(t);
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    const t0 = Date.now();
    const tool = this.parsed.tools.find((t) => t.name === name);
    let result: ToolResult;
    if (!tool) result = { content: [{ type: "text", text: `Unknown tool "${name}". Available: ${this.parsed.tools.map((t) => t.name).join(", ")}` }], isError: true };
    else {
      try { await this.opts.guard?.(this.baseUrl); } catch (e: any) { return this.log(name, args, t0, { content: [{ type: "text", text: `Blocked: ${e.message}` }], isError: true }); }
      result = await execute(tool, args, { baseUrl: this.baseUrl, auth: this.opts.auth, redirect: this.opts.redirect });
    }
    return this.log(name, args, t0, result);
  }

  private log(tool: string, args: unknown, t0: number, r: ToolResult) {
    this.emit("call", { ts: Date.now(), tool, args, ms: Date.now() - t0, isError: !!r.isError, preview: r.content[0].text.split("\n")[0] } satisfies CallLog);
    return r;
  }
}

/** One protocol-level Server per connection, all backed by the same shared Engine. */
export function createMcpServer(engine: Engine): Server {
  const server = new Server(
    { name: `mcp-${engine.parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`, version: engine.parsed.version },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: engine.parsed.tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
  }));
  server.setRequestHandler(CallToolRequestSchema, ({ params }) => engine.call(params.name, params.arguments));
  const notify = () => void server.sendToolListChanged().catch(() => {});
  engine.on("change", notify);
  server.onclose = () => void engine.off("change", notify);
  return server;
}

/**
 * Mounts Streamable HTTP (`{prefix}/mcp`) and legacy SSE (`{prefix}/sse` + `{prefix}/messages`).
 * The caller must have installed `express.json()`. `getEngine` may return undefined to 404.
 */
export function mountMcpHttp(app: Express, getEngine: (req: Request) => Engine | undefined, prefix = "") {
  const streams: Record<string, StreamableHTTPServerTransport> = {};
  const sse: Record<string, SSEServerTransport> = {};
  const rpcError = (res: Response, status: number, message: string) => res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

  app.all(`${prefix}/mcp`, async (req, res) => {
    let t = streams[String(req.headers["mcp-session-id"])];
    if (!t) {
      if (req.method !== "POST" || !isInitializeRequest(req.body)) return rpcError(res, 400, "No valid session: send an initialize request first");
      const engine = getEngine(req);
      if (!engine) return rpcError(res, 404, "Unknown MCP endpoint");
      const transport: StreamableHTTPServerTransport = (t = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => { streams[id] = transport; },
      }));
      transport.onclose = () => { if (transport.sessionId) delete streams[transport.sessionId]; };
      await createMcpServer(engine).connect(transport);
    }
    await t.handleRequest(req, res, req.body);
  });

  app.get(`${prefix}/sse`, async (req, res) => {
    const engine = getEngine(req);
    if (!engine) return void res.status(404).send("Unknown MCP endpoint");
    const t = new SSEServerTransport(req.originalUrl.split("?")[0].replace(/\/sse$/, "/messages"), res);
    sse[t.sessionId] = t;
    res.on("close", () => delete sse[t.sessionId]);
    await createMcpServer(engine).connect(t);
  });

  app.post(`${prefix}/messages`, async (req, res) => {
    const t = sse[String(req.query.sessionId)];
    if (!t) return void res.status(400).send("Unknown or expired SSE session");
    await t.handlePostMessage(req, res, req.body);
  });
}
