import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { mockApi } from "../src/mock-api.js";
import { open, seal } from "../src/token.js";

const listen = async (app: express.Express) => {
  const s = app.listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
};
const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() as any }));

test("tokens round-trip, are tamper-evident with a secret, and are plain without one", () => {
  const cfg = { spec: "https://x.test/openapi.json", auth: { bearer: "secret-token" } };
  const t = seal(cfg, "s3cret");
  assert.deepEqual(open(t, "s3cret"), cfg);
  assert.ok(!Buffer.from(t, "base64url").toString("latin1").includes("secret-token"));
  const bad = Buffer.from(t, "base64url"); bad[bad.length - 1] ^= 1;
  assert.throws(() => open(bad.toString("base64url"), "s3cret"));
  assert.throws(() => open(t, "wrong"));
  assert.deepEqual(open(seal({ a: 1 })), { a: 1 });
});

test("the demo spec served from public/ stays identical to demo/openapi.yaml", () => {
  assert.equal(readFileSync(new URL("../public/demo/openapi.yaml", import.meta.url), "utf8"), readFileSync(new URL("../demo/openapi.yaml", import.meta.url), "utf8"));
});

test("stateless app: generate, call, and a hosted POST-only MCP endpoint, with no server-side session", async () => {
  const api = await listen(express().use(mockApi()));
  const web = await listen(createApp({ stateless: true }));
  const cfg = { spec: readFileSync(new URL("../demo/openapi.yaml", import.meta.url), "utf8"), baseUrl: api.url, readOnly: false };

  const gen = await post(`${web.url}/api/generate`, cfg);
  assert.equal(gen.status, 200);
  assert.equal(gen.json.stateless, true);
  assert.equal(gen.json.tools.length, 4);
  assert.equal(gen.json.connect.streamableHttp, null); // pasted specs can't be hosted by URL
  assert.match(gen.json.hostedNote, /spec URL/);

  const made = await post(`${web.url}/api/call`, { config: cfg, tool: "createTask", args: { title: "stateless" } });
  assert.match(made.json.content[0].text, /^HTTP 201/);
  const ro = await post(`${web.url}/api/generate`, { ...cfg, readOnly: true });
  assert.deepEqual(ro.json.tools.map((t: any) => t.name), ["listTasks", "getTaskById"]);

  // Hosted endpoint: serve the demo spec over HTTP so the spec is a URL (127.0.0.1 is allowed outside production).
  const specHost = express().use(express.static(new URL("../public", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
  const specSrv = await listen(specHost);
  const urlCfg = { spec: `${specSrv.url}/demo/openapi.yaml`, baseUrl: api.url, readOnly: true };
  const hosted = await post(`${web.url}/api/generate`, urlCfg);
  const endpoint = hosted.json.connect.streamableHttp as string;
  assert.ok(endpoint?.includes("/h/"));
  assert.equal((await fetch(endpoint)).status, 405); // GET is not supported when stateless

  for (let i = 0; i < 2; i++) { // two independent clients: nothing is remembered between connections
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    assert.deepEqual((await c.listTools()).tools.map((t) => t.name).sort(), ["getTaskById", "listTasks"]);
    const r: any = await c.callTool({ name: "listTasks", arguments: {} });
    assert.match(r.content[0].text, /^HTTP 200/);
    await c.close();
  }
  assert.equal((await fetch(`${web.url}/h/not-a-token/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status, 404);
  for (const x of [specSrv, web, api]) { x.s.closeAllConnections(); x.s.close(); }
});
