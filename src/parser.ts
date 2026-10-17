import $RefParser from "@apidevtools/json-schema-ref-parser";
import YAML from "yaml";

export type Loc = "path" | "query" | "header";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  annotations: { title?: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  /** Everything the executor needs to turn flat MCP arguments back into an HTTP request. Never sent to clients. */
  http: {
    method: string;
    path: string;
    params: Record<string, { in: Loc; name: string }>;
    body: null | { flat: string[] } | { key: string };
    contentType: string;
  };
}

export interface ParsedSpec {
  title: string;
  version: string;
  baseUrl: string;
  tools: ToolDefinition[];
  /** Operations removed by read-only mode, e.g. "DELETE /tasks/{id}". */
  skipped: string[];
}

export interface ParseOptions {
  readOnly?: boolean;
  /** Where the spec came from; used to resolve relative `servers[].url`. */
  specUrl?: string;
  /** Allow `$ref`s to other files/URLs. Disable for untrusted input. Default true. */
  external?: boolean;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const SKIP_HEADERS = /^(authorization|accept|content-type)$/i;
// OpenAPI-only keywords that are not valid (or not useful) in a JSON Schema Draft-07 tool schema.
const OPENAPI_ONLY = new Set(["example", "examples", "xml", "externalDocs", "discriminator", "deprecated"]);

export const isInline = (s: string) => s.includes("\n") || s.trimStart().startsWith("{");

/** OpenAPI 3.0 schema object -> JSON Schema Draft-07. Residual `$ref`s (only left behind by circular schemas) become open schemas. */
export function toDraft07(s: any, dropReadOnly = false): any {
  if (Array.isArray(s)) return s.map((x) => toDraft07(x, dropReadOnly));
  if (!s || typeof s !== "object") return s;
  if (s.$ref) return { description: `Recursive reference to ${String(s.$ref).split("/").pop()}` };
  const out: any = {};
  for (const [k, v] of Object.entries<any>(s)) {
    if (OPENAPI_ONLY.has(k)) continue;
    if (k === "properties")
      out[k] = Object.fromEntries(
        Object.entries<any>(v).filter(([, p]) => !(dropReadOnly && p?.readOnly)).map(([n, p]) => [n, toDraft07(p, dropReadOnly)]),
      );
    else out[k] = ["default", "enum", "const"].includes(k) ? v : toDraft07(v, dropReadOnly);
  }
  if (out.nullable) {
    if (out.type) out.type = [out.type].flat().concat("null");
    if (out.enum) out.enum = [...out.enum, null];
  }
  delete out.nullable;
  for (const [ex, lim] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]] as const)
    if (typeof out[ex] === "boolean") {
      if (out[ex] && out[lim] !== undefined) { out[ex] = out[lim]; delete out[lim]; } else delete out[ex];
    }
  if (dropReadOnly && Array.isArray(out.required)) {
    out.required = out.required.filter((r: string) => r in (out.properties ?? {}));
    if (!out.required.length) delete out.required;
  }
  return out;
}

export async function parseSpec(src: string | object, opts: ParseOptions = {}): Promise<ParsedSpec> {
  const specUrl = opts.specUrl ?? (typeof src === "string" && /^https?:\/\//.test(src) ? src : undefined);
  const input = typeof src === "string" && isInline(src) ? YAML.parse(src) : src;
  const doc: any = await $RefParser.dereference(input as any, {
    dereference: { circular: "ignore" },
    resolve: { external: opts.external ?? true },
  });
  if (!String(doc?.openapi).startsWith("3.")) throw new Error("Not an OpenAPI 3.x document (missing or unsupported `openapi` field; Swagger 2.0 is not supported).");
  if (!doc.paths || typeof doc.paths !== "object") throw new Error("OpenAPI document has no `paths`.");

  const ops = Object.entries<any>(doc.paths).flatMap(([path, item]) =>
    METHODS.filter((m) => item?.[m]).map((method) => ({ path, method, op: item[method], shared: item.parameters ?? [] })),
  );
  // Read-only is enforced here, before any tool exists: write operations never reach the protocol layer.
  const allowed = (o: { method: string }) => !opts.readOnly || o.method === "get";
  const used = new Set<string>();
  const unique = (n: string) => { let u = n, i = 2; while (used.has(u)) u = `${n}_${i++}`; used.add(u); return u; };

  const tools = ops.filter(allowed).map((o) => {
    const name = unique(
      (o.op.operationId ?? `${o.method}_${o.path}`).replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || o.method,
    );
    // Path-level params are overridden by operation-level params with the same (in, name).
    const params = Object.values(
      Object.fromEntries([...o.shared, ...(o.op.parameters ?? [])].map((p: any) => [`${p.in}:${p.name}`, p])),
    ).filter((p: any) => ["path", "query", "header"].includes(p.in) && !(p.in === "header" && SKIP_HEADERS.test(p.name))) as any[];

    const key = (p: any) => (params.filter((q) => q.name === p.name).length > 1 ? `${p.in}_${p.name}` : p.name);
    const properties: Record<string, any> = Object.fromEntries(
      params.map((p) => [key(p), { ...toDraft07(p.schema ?? {}), ...(p.description && { description: p.description }) }]),
    );
    const required = params.filter((p) => p.required || p.in === "path").map(key);
    const paramMap = Object.fromEntries(params.map((p) => [key(p), { in: p.in as Loc, name: p.name }]));

    const content = Object.entries<any>(o.op.requestBody?.content ?? {});
    const [contentType = "application/json", media] = content.find(([t]) => /json/.test(t)) ?? content[0] ?? [];
    const bodySchema = media?.schema ? toDraft07(media.schema, true) : undefined;
    let body: ToolDefinition["http"]["body"] = null;
    if (bodySchema?.properties && Object.keys(bodySchema.properties).every((k) => !(k in properties))) {
      // Flatten object bodies into top-level args: friendlier for LLMs than a nested `body` wrapper.
      Object.assign(properties, bodySchema.properties);
      if (o.op.requestBody.required) required.push(...(bodySchema.required ?? []));
      body = { flat: Object.keys(bodySchema.properties) };
    } else if (bodySchema) {
      const bk = "body" in properties ? "requestBody" : "body";
      properties[bk] = { ...bodySchema, description: o.op.requestBody.description ?? "Request body" };
      if (o.op.requestBody.required) required.push(bk);
      body = { key: bk };
    }

    const m = o.method.toUpperCase();
    return {
      name,
      description: [...new Set([o.op.summary, o.op.description].filter(Boolean))].join(" — ") || `${m} ${o.path}`,
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties,
        ...(required.length && { required: [...new Set(required)] }),
        additionalProperties: false,
      },
      annotations: {
        title: o.op.summary,
        readOnlyHint: ["GET", "HEAD", "OPTIONS"].includes(m),
        destructiveHint: m === "DELETE",
        idempotentHint: ["GET", "HEAD", "PUT", "DELETE"].includes(m),
      },
      http: { method: m, path: o.path, params: paramMap, body, contentType },
    } satisfies ToolDefinition;
  });

  const server = doc.servers?.[0];
  let baseUrl: string = (server?.url ?? "").replace(/\{(\w+)\}/g, (_: string, v: string) => server.variables?.[v]?.default ?? "");
  if (!/^https?:\/\//.test(baseUrl) && specUrl) baseUrl = new URL(baseUrl || "/", specUrl).href;

  return {
    title: doc.info?.title ?? "API",
    version: doc.info?.version ?? "0.0.0",
    baseUrl: baseUrl.replace(/\/$/, ""),
    tools,
    skipped: ops.filter((o) => !allowed(o)).map((o) => `${o.method.toUpperCase()} ${o.path}`),
  };
}

export interface ToolDiff { added: string[]; removed: string[]; changed: string[] }

export function diffTools(prev: ToolDefinition[], next: ToolDefinition[]): ToolDiff {
  const sig = (t: ToolDefinition) => JSON.stringify([t.description, t.inputSchema, t.http]);
  const before = new Map(prev.map((t) => [t.name, sig(t)]));
  return {
    added: next.filter((t) => !before.has(t.name)).map((t) => t.name),
    removed: prev.filter((t) => !next.some((n) => n.name === t.name)).map((t) => t.name),
    changed: next.filter((t) => before.has(t.name) && before.get(t.name) !== sig(t)).map((t) => t.name),
  };
}
