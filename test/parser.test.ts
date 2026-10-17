import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv } from "ajv";
import { diffTools, parseSpec, toDraft07 } from "../src/parser.js";

const demo = readFileSync(new URL("../demo/openapi.yaml", import.meta.url), "utf8");
const mini = (paths: object, extra: object = {}) => JSON.stringify({ openapi: "3.0.3", info: { title: "T", version: "1" }, paths, ...extra });
const ok = { responses: { 200: { description: "ok" } } };

test("demo spec compiles to four typed tools", async () => {
  const p = await parseSpec(demo);
  assert.deepEqual(p.tools.map((t) => t.name), ["listTasks", "createTask", "getTaskById", "deleteTask"]);
  assert.equal(p.baseUrl, "https://api.example.com/v1");
  const [list, create, get] = p.tools;
  assert.equal(list.description, "List tasks — Retrieve a paginated list of tasks with optional filtering by status.");
  assert.deepEqual(list.inputSchema.properties.status.enum, ["completed", "pending"]);
  assert.equal(list.inputSchema.properties.limit.default, 10);
  assert.equal(list.inputSchema.required, undefined);
  // body object is flattened into top-level arguments; OpenAPI-only `example` is stripped
  assert.deepEqual(Object.keys(create.inputSchema.properties), ["title", "description"]);
  assert.deepEqual(create.inputSchema.required, ["title"]);
  assert.ok(!JSON.stringify(create.inputSchema).includes("example"));
  assert.equal(create.inputSchema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.deepEqual(get.inputSchema.required, ["id"]);
  assert.equal(get.inputSchema.properties.id.type, "integer");
  assert.equal(p.tools[3].annotations.destructiveHint, true);
  assert.equal(list.annotations.readOnlyHint, true);
});

test("read-only mode removes write operations before tools exist", async () => {
  const p = await parseSpec(demo, { readOnly: true });
  assert.deepEqual(p.tools.map((t) => t.name), ["listTasks", "getTaskById"]);
  assert.deepEqual(p.skipped, ["POST /tasks", "DELETE /tasks/{id}"]);
});

test("name falls back to method_path and is deduplicated", async () => {
  const p = await parseSpec(mini({ "/users/{userId}/posts": { get: { ...ok, parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }] } }, "/users/{userId}-posts": { get: ok } }));
  assert.equal(p.tools[0].name, "get_users_userId_posts");
  assert.equal(new Set(p.tools.map((t) => t.name)).size, 2);
});

test("circular $ref does not throw and still yields a compilable schema", async () => {
  const node = { type: "object", properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/components/schemas/Node" } } } };
  const p = await parseSpec(mini(
    { "/tree": { post: { operationId: "putTree", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } }, ...ok } } },
    { components: { schemas: { Node: node } } },
  ));
  const schema = p.tools[0].inputSchema;
  assert.doesNotThrow(() => JSON.stringify(schema));
  assert.doesNotThrow(() => new Ajv({ strict: false }).compile(schema));
});

test("same name in different locations gets disambiguated; path-level params are merged", async () => {
  const p = await parseSpec(mini({
    "/a/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }, { name: "X-Trace", in: "header", schema: { type: "string" } }],
      get: { ...ok, parameters: [{ name: "id", in: "query", schema: { type: "string" } }] },
    },
  }));
  const t = p.tools[0];
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ["X-Trace", "path_id", "query_id"]);
  assert.deepEqual(t.http.params.path_id, { in: "path", name: "id" });
  assert.deepEqual(t.inputSchema.required, ["path_id"]);
});

test("non-object bodies go under `body`; readOnly properties are dropped from request bodies", async () => {
  const p = await parseSpec(mini({
    "/bulk": { post: { operationId: "bulk", requestBody: { required: true, content: { "application/json": { schema: { type: "array", items: { type: "string" } } } } }, ...ok } },
    "/u": { post: { operationId: "mkUser", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["id", "name"], properties: { id: { type: "integer", readOnly: true }, name: { type: "string" } } } } } }, ...ok } },
  }));
  assert.deepEqual(p.tools[0].inputSchema.required, ["body"]);
  assert.deepEqual(Object.keys(p.tools[1].inputSchema.properties), ["name"]);
  assert.deepEqual(p.tools[1].inputSchema.required, ["name"]);
});

test("OpenAPI 3.0 schema quirks become Draft-07", () => {
  assert.deepEqual(toDraft07({ type: "string", nullable: true }), { type: ["string", "null"] });
  assert.deepEqual(toDraft07({ type: "integer", minimum: 0, exclusiveMinimum: true }), { type: "integer", exclusiveMinimum: 0 });
});

test("relative server URLs resolve against the spec URL; non-3.x documents are rejected", async () => {
  const p = await parseSpec(mini({}, { servers: [{ url: "/api/v2" }] }), { specUrl: "https://example.org/docs/openapi.json" });
  assert.equal(p.baseUrl, "https://example.org/api/v2");
  await assert.rejects(parseSpec("swagger: '2.0'\npaths: {}\n"), /OpenAPI 3/);
});

test("diffTools reports added, removed and changed tools", async () => {
  const a = (await parseSpec(demo)).tools;
  const b = (await parseSpec(demo, { readOnly: true })).tools.map((t) => (t.name === "listTasks" ? { ...t, description: "changed" } : t));
  assert.deepEqual(diffTools(a, b), { added: [], removed: ["createTask", "deleteTask"], changed: ["listTasks"] });
});
