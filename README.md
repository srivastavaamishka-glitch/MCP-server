# Anything-to-MCP

Point it at an OpenAPI 3.x spec, get a live MCP server. No codegen, no build step: the spec is compiled into tool schemas in memory and every call goes through one generic HTTP dispatcher.

```bash
# stdio MCP server for any spec (file or URL), read-only, with auth injected from env
API_BEARER_TOKEN=xxx npx -y github:srivastavaamishka-glitch/MCP-server --spec https://example.com/openapi.yaml --read-only

# or Docker
docker run -i --rm -e API_BEARER_TOKEN=xxx anything-to-mcp --spec https://example.com/openapi.yaml --read-only
```

`npx github:...` works as soon as the repo is pushed (the `prepare` script builds `dist/`). Replace `<your-github-user>`, or publish to npm and drop the `github:` prefix.

## 60-second demo

```bash
npm install
npm test            # 12 tests: parser edge cases, executor, hot reload, both HTTP transports
npm run demo        # starts the mock Task Manager API, launches the generated MCP server over stdio,
                    # and completes create/list/get/delete using only MCP tool calls
npm start           # web generator on http://localhost:3000  (click "Load demo" -> "Generate server")
```

## Use it from an MCP client

Claude Desktop / any stdio client:

```json
{ "mcpServers": { "tasks": {
  "command": "npx",
  "args": ["-y", "github:srivastavaamishka-glitch/MCP-server", "--spec", "/abs/path/openapi.yaml", "--base-url", "http://localhost:4000"],
  "env": { "API_BEARER_TOKEN": "xxx" }
} } }
```

Remote (Streamable HTTP), either from the hosted generator (`/h/<id>/mcp`) or your own process:

```bash
npx -y github:srivastavaamishka-glitch/MCP-server --spec ./openapi.yaml --http 8080   # /mcp and /sse
claude mcp add --transport http tasks http://localhost:8080/mcp
```

## CLI

| Flag / env | Meaning |
|---|---|
| `--spec` / `OPENAPI_SPEC` | OpenAPI 3.x YAML/JSON, file path or URL |
| `--read-only` / `READ_ONLY=true` | Only `GET` operations are compiled into tools |
| `--base-url` / `BASE_URL` | Override `servers[0].url` (the demo spec points at `api.example.com`) |
| `--http <port>` / `PORT` | Serve Streamable HTTP + SSE instead of stdio |
| `--poll <seconds>` | Re-fetch URL specs periodically. Local files are always watched |
| `API_BEARER_TOKEN` | Sent as `Authorization: Bearer ...` |
| `API_KEY`, `API_KEY_NAME`, `API_KEY_IN` | API key as header (default `X-API-Key`) or `query` param |
| `API_HEADERS` | JSON object of extra static headers |

## How it maps to the brief

- **Spec → tools** (`src/parser.ts`): `$ref`s are dereferenced with `@apidevtools/json-schema-ref-parser`. Name is `operationId`, falling back to `method_path` (sanitized to `[a-zA-Z0-9_-]`, deduplicated). Description is `summary — description`. Tool annotations carry `readOnlyHint`/`destructiveHint`/`idempotentHint`.
- **Parameter unification**: path, query, header and body inputs become one flat Draft-07 `inputSchema`. Object bodies are flattened into top-level arguments (`createTask({title, description})`); non-object bodies go under `body`. Same name in two locations becomes `path_id` / `query_id`. A per-tool map records where each argument goes, and `src/executor.ts` splits them back into URL, query, headers and body.
- **Schema hygiene**: OpenAPI-only keywords (`example`, `xml`, …) are stripped, `nullable` → `type: [..., "null"]`, boolean `exclusiveMinimum` → numeric, `readOnly` properties are dropped from request bodies.
- **Fail-fast arguments**: arguments are validated with Ajv before any network call, with light coercion (`"5"` → `5`). Errors come back as `isError` text that names the offending field. Network failures and non-2xx responses come back the same way, so the model can recover.
- **Auth proxying**: credentials come from env (CLI) or the session (web) and are injected per request. They never appear in tool output or error messages.
- **Read-only**: enforced in the parser. Write operations are never turned into tools, so they do not exist in `tools/list` and calling one returns "Unknown tool". Nothing depends on a prompt.
- **Hot reload** (`Engine` in `src/server.ts`): file specs are watched, URL specs polled with `--poll`. A reload parses first and swaps second, so a half-saved or broken spec keeps the previous tools. On a real change, every connected client gets `notifications/tools/list_changed`.
- **`$ref` robustness**: circular references are left as pointers by the dereferencer and then replaced with an open schema (`{description: "Recursive reference to Node"}`). They never throw and never produce a non-serializable object. A reference to something that does not exist is a broken spec and fails loading with the parser's error.

## Web generator and hosted API

`npm start` (or `node dist/web.js`) serves a single-page dashboard:

1. Paste a URL or YAML/JSON, toggle read-only, set a base URL and credentials, **Generate**.
2. Inspect each tool's Draft-07 schema, edit arguments and **Run** it live.
3. Re-generate with a different setting (e.g. flip read-only) to see a tool diff (`+ added`, `− removed`, `~ changed`). Connected clients are notified.
4. Copy the stdio command, Docker command, or the hosted endpoint `/h/<id>/mcp` (Streamable HTTP) / `/h/<id>/sse`.
5. A live log shows calls from the page and from any MCP client connected to the hosted endpoint.

The same process mounts the demo: `/demo/openapi.yaml`, an open mock API at `/demo-api`, and a bearer-protected one at `/demo-api-auth` (token `demo-token`). "Demo with auth" wires them up. Clear the token and run a tool to watch it 401.

### Deploy

`render.yaml` is included (Render: New → Blueprint). Any Node host works: build `npm ci --include=dev --ignore-scripts && npm run build`, start `node dist/web.js`, health check `/health`. Or `docker run -p 3000:3000 --entrypoint node anything-to-mcp dist/web.js`.

### Deploy on Vercel

The same app runs on Vercel in **stateless mode** (`api/index.js` + `vercel.json`): there is no server-side session, so nothing breaks when a serverless instance is recycled.

1. Push the repo to GitHub, then Vercel -> Add New -> Project -> import it. Framework preset **Other**; build and output settings come from `vercel.json`.
2. Add the environment variable `SESSION_SECRET` (any long random string). It encrypts the hosted-endpoint token, which is what lets an endpoint carry credentials safely. Optionally set `REPO_SLUG`.
3. Deploy, then use the **production** domain. Preview deployments can sit behind Vercel Deployment Protection, which blocks the app from fetching its own demo spec.
4. Open the URL -> "Load demo" -> "Generate server".

Stateless mode differences: the hosted endpoint is `POST /h/<token>/mcp` (Streamable HTTP, no SSE, no GET stream), and it is only offered for specs given as a URL; the live log shows calls made from the page only; spec edits are picked up within about 60 seconds instead of instantly; the mock demo API keeps its data in memory per instance, so it can reset. Run it locally with `STATELESS=1 npm start`.

## Limitations to know about

- **Hosted mode is a demo, not a multi-tenant service.** Sessions and the credentials in them live in process memory (capped at 100, lost on restart). The unguessable session id is the only access control on `/h/<id>/*`. Do not put real production credentials into a public instance without adding authentication in front.
- **SSRF protections are best-effort.** In production mode, spec URLs and base URLs that resolve to private, loopback or link-local addresses are refused, redirects are not followed, and `$ref`s to files/URLs are disabled. A DNS-rebinding race between check and connect is not closed. Local development (`NODE_ENV` not `production`) allows private targets so you can point at `localhost`; override with `ALLOW_PRIVATE=0|1`.
- Not supported: `multipart/form-data` file uploads, cookie parameters, non-JSON/form request bodies. Bodies that are `oneOf`/`anyOf`/`allOf` at the top level are passed through under `body` rather than flattened.
- Read-only mode keeps `GET` only (not `HEAD`/`OPTIONS`).
- SSE is deprecated in the MCP spec in favour of Streamable HTTP. Both are served; prefer `/mcp`.
- Hot reload only helps clients that honor `tools/list_changed`; others pick up the change on their next `tools/list`.
- The verification client is a deterministic script, not an LLM agent. It proves the tools work end to end over a real stdio MCP connection. It does not prove a model picks the right tool.

## Layout

```
src/parser.ts     spec -> ToolDefinition[] (+ read-only filter, Draft-07 conversion, diff)
src/executor.ts   ToolDefinition + args -> HTTP request (validation, auth, error shaping)
src/server.ts     Engine (hot reload, call log), MCP Server factory, stdio/HTTP/SSE wiring
src/cli.ts        npx / docker entrypoint
src/app.ts        dashboard API, hosted MCP endpoints, SSRF policy, demo mounts (stateful + stateless modes)
src/web.ts        local/Docker/Render entry (listens on PORT)
src/token.ts      sealed stateless tokens (AES-256-GCM)
api/index.js      Vercel entry
vercel.json       Vercel routing
src/mock-api.ts   in-memory Task Manager REST API
public/index.html single-file dashboard (no build step)
demo/             openapi.yaml, mock-server.ts, agent.ts (verification client)
test/             parser + end-to-end tests
```
