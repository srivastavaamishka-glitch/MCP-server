#!/usr/bin/env node
import { parseArgs } from "node:util";
import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { authFromEnv } from "./executor.js";
import { Engine, createMcpServer, mountMcpHttp } from "./server.js";

const HELP = `anything-to-mcp: expose any OpenAPI 3.x spec as an MCP server

  npx anything-to-mcp --spec <file|url> [--read-only] [--base-url <url>] [--http <port>] [--poll <seconds>]

  --spec        OpenAPI YAML/JSON file or URL            (env OPENAPI_SPEC)
  --read-only   expose GET operations only               (env READ_ONLY=true)
  --base-url    override servers[0].url from the spec    (env BASE_URL)
  --http <port> serve Streamable HTTP (/mcp) + SSE (/sse) instead of stdio  (env PORT)
  --poll <s>    re-fetch URL specs every <s> seconds; local files are always watched

Auth is injected from env: API_BEARER_TOKEN | API_KEY [+ API_KEY_NAME, API_KEY_IN=header|query] | API_HEADERS='{"X-Foo":"bar"}'`;

const { values: v } = parseArgs({
  options: {
    spec: { type: "string" }, "read-only": { type: "boolean" }, "base-url": { type: "string" },
    http: { type: "string" }, poll: { type: "string" }, help: { type: "boolean", short: "h" },
  },
});
const source = v.spec ?? process.env.OPENAPI_SPEC;
if (v.help || !source) { console.error(HELP); process.exit(v.help ? 0 : 1); }

// stdout belongs to the protocol in stdio mode: all human-facing output goes to stderr.
const engine = new Engine({
  source: source!,
  readOnly: v["read-only"] ?? process.env.READ_ONLY === "true",
  baseUrl: v["base-url"] ?? process.env.BASE_URL,
  auth: authFromEnv(),
  pollMs: v.poll ? Number(v.poll) * 1000 : undefined,
});
try { await engine.load(); } catch (e: any) { console.error(`Failed to load spec: ${e.message}`); process.exit(1); }
engine.watch();
engine.on("change", (d) => console.error(`[reload] +${d.added.length} -${d.removed.length} ~${d.changed.length} tools`));
const { tools, skipped, title } = engine.parsed;
console.error(`${title}: ${tools.length} tools${skipped.length ? ` (read-only: ${skipped.length} write operations removed)` : ""} -> ${engine.baseUrl || "(no base URL: set BASE_URL)"}`);

const port = v.http ?? process.env.PORT;
if (port) {
  const app = express().use(express.json());
  app.get("/health", (_req, res) => void res.json({ ok: true, tools: engine.parsed.tools.length }));
  mountMcpHttp(app, () => engine);
  app.listen(Number(port), () => console.error(`MCP over HTTP on :${port}  (Streamable: /mcp, SSE: /sse)`));
} else {
  await createMcpServer(engine).connect(new StdioServerTransport());
}
