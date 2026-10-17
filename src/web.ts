import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const stateless = process.env.STATELESS === "1";
createApp({ stateless }).listen(port, "0.0.0.0", () =>
  console.log(`Anything-to-MCP running on http://localhost:${port}${stateless ? " (stateless mode)" : ""}`));
