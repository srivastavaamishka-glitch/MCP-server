import { Ajv, type ValidateFunction } from "ajv";
import type { Loc, ToolDefinition } from "./parser.js";

export interface AuthConfig {
  bearer?: string;
  apiKey?: string;
  /** Header (or query param, if apiKeyIn=query) name for the API key. Default: X-API-Key / api_key. */
  apiKeyName?: string;
  apiKeyIn?: "header" | "query";
  /** Extra static headers. */
  headers?: Record<string, string>;
}

export interface ExecConfig {
  baseUrl: string;
  auth?: AuthConfig;
  timeoutMs?: number;
  /** "manual" stops the executor following redirects (used by the hosted server to avoid redirect-based SSRF). */
  redirect?: "follow" | "manual";
}

export interface ToolResult { [k: string]: unknown; content: { type: "text"; text: string }[]; isError?: boolean }

export const authFromEnv = (env: NodeJS.ProcessEnv = process.env): AuthConfig => ({
  bearer: env.API_BEARER_TOKEN,
  apiKey: env.API_KEY,
  apiKeyName: env.API_KEY_NAME,
  apiKeyIn: env.API_KEY_IN === "query" ? "query" : "header",
  headers: env.API_HEADERS ? JSON.parse(env.API_HEADERS) : undefined,
});

const MAX_CHARS = 50_000;
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: true }); // coerce: LLMs often send "5" for integers
const validators = new WeakMap<ToolDefinition, ValidateFunction>();
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError && { isError }) });

/** The single universal dispatcher: every tool is just metadata + this function. */
export async function execute(tool: ToolDefinition, args: unknown, cfg: ExecConfig): Promise<ToolResult> {
  const validate = validators.get(tool) ?? ajv.compile(tool.inputSchema);
  validators.set(tool, validate);
  const input: Record<string, any> = structuredClone(args ?? {}) as any;
  if (!validate(input)) {
    const problems = validate.errors!.map((e) => `${e.instancePath ? e.instancePath.slice(1) + " " : ""}${e.message}${e.params.additionalProperty ? ` (${e.params.additionalProperty})` : ""}`);
    return text(`Invalid arguments for ${tool.name}: ${problems.join("; ")}. Expected properties: ${Object.keys(tool.inputSchema.properties).join(", ") || "(none)"}.`, true);
  }

  const { http } = tool;
  const pick = (loc: Loc) => Object.entries(http.params).filter(([k, p]) => p.in === loc && input[k] !== undefined).map(([k, p]) => [p.name, input[k]] as const);
  const pathVals = Object.fromEntries(pick("path"));
  const path = http.path.replace(/\{([^}]+)\}/g, (_, n) => encodeURIComponent(String(pathVals[n] ?? "")));
  const url = new URL(cfg.baseUrl.replace(/\/$/, "") + path);
  for (const [k, v] of pick("query")) [v].flat().forEach((x) => url.searchParams.append(k, typeof x === "object" ? JSON.stringify(x) : String(x)));

  const a = cfg.auth ?? {};
  const headers: Record<string, string> = { Accept: "application/json", ...a.headers, ...Object.fromEntries(pick("header").map(([k, v]) => [k, String(v)])) };
  if (a.bearer) headers.Authorization = `Bearer ${a.bearer}`;
  if (a.apiKey) a.apiKeyIn === "query" ? url.searchParams.set(a.apiKeyName ?? "api_key", a.apiKey) : (headers[a.apiKeyName ?? "X-API-Key"] = a.apiKey);

  let body: string | undefined;
  if (http.body) {
    const data = "flat" in http.body ? Object.fromEntries(http.body.flat.filter((k) => input[k] !== undefined).map((k) => [k, input[k]])) : input[http.body.key];
    if (data !== undefined) {
      const form = /x-www-form-urlencoded/.test(http.contentType);
      body = form ? new URLSearchParams(data).toString() : JSON.stringify(data);
      headers["Content-Type"] = form ? http.contentType : /json/.test(http.contentType) ? http.contentType : "application/json";
    }
  }

  const where = `${http.method} ${url.origin}${url.pathname}`; // never echo the query string: it may carry an API key
  try {
    const res = await fetch(url, { method: http.method, headers, body, redirect: cfg.redirect ?? "follow", signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000) });
    const raw = await res.text();
    let pretty = raw;
    try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* not JSON: pass through */ }
    const out = `HTTP ${res.status} ${res.statusText}`.trim() + (pretty ? `\n${pretty}` : "");
    return text(out.length > MAX_CHARS ? out.slice(0, MAX_CHARS) + `\n…[truncated ${out.length - MAX_CHARS} chars]` : out, !res.ok);
  } catch (e: any) {
    const why = e.name === "TimeoutError" ? "timed out" : (e.cause?.code ?? e.message);
    return text(`Request failed (${where}): ${why}`, true);
  }
}
