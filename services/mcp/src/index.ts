import { createApp } from "./app.js";

const PORT = Number(process.env.PORT) || 8082;
const ISSUER_URL = process.env.MCP_ISSUER_URL ?? `http://127.0.0.1:${PORT}`;

createApp(ISSUER_URL)
  .then(({ app }) => {
    app.listen(PORT, () => {
      console.log(`lms-279 mcp (phase 0) listening on ${ISSUER_URL}`);
    });
  })
  .catch((err) => {
    console.error("failed to start mcp service", err);
    process.exit(1);
  });
