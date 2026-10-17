/**
 * Verification client: starts the mock Task Manager API, launches the generated MCP server over stdio,
 * and completes a task lifecycle using ONLY MCP tool calls. Exits non-zero on any failed assertion.
 *   npm run demo
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mockApi } from "../src/mock-api.js";

const TOKEN = "s3cret";
const root = fileURLToPath(new URL("../", import.meta.url));
const mock = express().use(mockApi(TOKEN)).listen(0);
await new Promise((r) => mock.once("listening", r));
const baseUrl = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;

async function connect(flags: string[], env: Record<string, string> = {}) {
  const client = new Client({ name: "verification-agent", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, cwd: root, stderr: "ignore",
    args: ["--import", "tsx", "src/cli.ts", "--spec", "demo/openapi.yaml", ...flags],
    env: { BASE_URL: baseUrl, ...env },
  }));
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r: any = await c.callTool({ name, arguments: args });
  const text: string = r.content[0].text;
  const [head, ...rest] = text.split("\n");
  return { isError: !!r.isError, status: Number(/^HTTP (\d+)/.exec(head)?.[1]), text, json: () => JSON.parse(rest.join("\n")) };
}

const ok = (msg: string) => console.log(`  ✓ ${msg}`);

try {
  console.log("Full access, bearer token configured");
  const agent = await connect([], { API_BEARER_TOKEN: TOKEN });
  const names = (await agent.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["createTask", "deleteTask", "getTaskById", "listTasks"]);
  ok(`discovered tools: ${names.join(", ")}`);

  const created = await call(agent, "createTask", { title: "Submit hackathon project link", description: "Attach repo + deploy URL" });
  assert.equal(created.status, 201);
  const { id } = created.json();
  ok(`createTask -> 201, new task id ${id}`);

  const pending = await call(agent, "listTasks", { status: "pending", limit: 50 });
  assert.ok(pending.json().some((t: any) => t.id === id && t.completed === false));
  ok("listTasks(status=pending) contains the new task");

  const fetched = await call(agent, "getTaskById", { id });
  assert.equal(fetched.json().title, "Submit hackathon project link");
  ok("getTaskById returns it (path parameter routed correctly)");

  assert.equal((await call(agent, "deleteTask", { id })).status, 204);
  ok("deleteTask -> 204");

  const gone = await call(agent, "getTaskById", { id });
  assert.ok(gone.isError && gone.status === 404);
  ok("getTaskById after delete -> 404 surfaced as isError");

  const bad = await call(agent, "createTask", {});
  assert.ok(bad.isError && /title/.test(bad.text));
  ok(`missing argument rejected before any HTTP call: "${bad.text.slice(0, 70)}…"`);
  await agent.close();

  console.log("Read-only mode");
  const ro = await connect(["--read-only"], { API_BEARER_TOKEN: TOKEN });
  const roNames = (await ro.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(roNames, ["getTaskById", "listTasks"]);
  ok(`only ${roNames.join(", ")} exist in tools/list`);
  const denied = await call(ro, "deleteTask", { id: 1 });
  assert.ok(denied.isError && /Unknown tool/.test(denied.text));
  ok("calling deleteTask is impossible: unknown tool, no HTTP request made");
  assert.equal((await call(ro, "listTasks")).status, 200);
  await ro.close();

  console.log("Auth proxying");
  const anon = await connect([]);
  assert.equal((await call(anon, "listTasks")).status, 401);
  ok("no token configured -> API answers 401");
  await anon.close();

  console.log("\nAll checks passed.");
} catch (e: any) {
  console.error(`\n  ✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  mock.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
