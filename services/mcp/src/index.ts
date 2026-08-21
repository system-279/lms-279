import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

createApp(config.issuerUrl, config.port, {
  apiKey: config.firebaseWebApiKey ?? "",
  authDomain: config.firebaseAuthDomain ?? "",
  projectId: config.firebaseProjectId ?? "",
})
  .then(({ app }) => {
    app.listen(config.port, () => {
      console.log(`lms-279 mcp listening on ${config.issuerUrl}`);
    });
  })
  .catch((err) => {
    console.error("failed to start mcp service", err);
    process.exit(1);
  });
