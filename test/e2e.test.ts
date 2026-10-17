import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import express from "express";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { mockApi } from "../src/mock-api.js";
import { Engine, createMcpServer, mountMcpHttp } from "../src/server.js";

const specPath = fileURLToPath(new URL("../demo/openapi.yaml", import.meta.url));
const listen = async (app: express.Express) => {
  const s = app.listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
};
const text = (r: any) => r.content[0].text as string;

test("executor: path/query/body/auth reach the REST API correctly", async () => {
  const api = await listen(express().use(mockApi("tok")));
  const engine = new Engine({ source: specPath, baseUrl: api.url, auth: { bearer: "tok" } });
  await engine.load();
  const made = await engine.call("createTask", { title: "t1" });
  assert.match(text(made), /^HTTP 201/);
  assert.match(text(await engine.call("listTasks", { status: "pending", limit: "2" })), /t1|Write README/); // "2" is coerced to an integer
  assert.match(text(await engine.call("getTaskById", { id: 9999 })), /^HTTP 404/);
  assert.equal((await engine.call("getTaskById", { id: 9999 })).isError, true);
  const bad = await engine.call("getTaskById", { id: "abc" });
  assert.ok(bad.isError && /must be integer/.test(text(bad)));
  const extra = await engine.call("createTask", { title: "x", bogus: 1 });
  assert.ok(extra.isError && /bogus/.test(text(extra)));
  const noAuth = new Engine({ source: specPath, baseUrl: api.url });
  await noAuth.load();
  assert.match(text(await noAuth.call("listTasks", {})), /^HTTP 401/);
  const down = new Engine({ source: specPath, baseUrl: "http://127.0.0.1:1" });
  await down.load();
  assert.match(text(await down.call("listTasks", {})), /Request failed/);
  api.s.close();
});

test("hot reload: edits to the spec file reach connected clients; a broken edit keeps the old tools", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "a2m-")), "openapi.yaml");
  copyFileSync(specPath, file);
  const engine = new Engine({ source: file });
  await engine.load();
  const stop = engine.watch();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  let notified = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notified++; });
  await Promise.all([createMcpServer(engine).connect(st), client.connect(ct)]);
  assert.equal((await client.listTools()).tools.length, 4);

  const next = YAML.parse(readFileSync(file, "utf8"));
  next.paths["/ping"] = { get: { operationId: "ping", responses: { 200: { description: "ok" } } } };
  delete next.paths["/tasks/{id}"].delete;
  writeFileSync(file, YAML.stringify(next));
  const deadline = Date.now() + 5000;
  while (!notified && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(notified, 1);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["createTask", "getTaskById", "listTasks", "ping"]);

  writeFileSync(file, "this: [is not, valid openapi");
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), names);
  stop();
  await client.close();
});

test("hosted transports: Streamable HTTP and SSE both serve the same tools", async () => {
  const api = await listen(express().use(mockApi()));
  const engine = new Engine({ source: specPath, baseUrl: api.url, readOnly: true });
  await engine.load();
  const app = express().use(express.json());
  mountMcpHttp(app, () => engine, "/h/:id");
  const hosted = await listen(app);
  for (const transport of [new StreamableHTTPClientTransport(new URL(`${hosted.url}/h/abc/mcp`)), new SSEClientTransport(new URL(`${hosted.url}/h/abc/sse`))]) {
    const c = new Client({ name: "t", version: "1" });
    await c.connect(transport);
    assert.deepEqual((await c.listTools()).tools.map((t) => t.name).sort(), ["getTaskById", "listTasks"]);
    assert.match(text(await c.callTool({ name: "getTaskById", arguments: { id: 1 } })), /^HTTP 200/);
    await c.close();
  }
  hosted.s.closeAllConnections(); hosted.s.close(); api.s.close();
});
