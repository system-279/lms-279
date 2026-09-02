import { createApp } from "./app.js";
import { logger } from "./logger.js";

const app = createApp();
const port = process.env.PORT || 8081;

app.listen(port, () => {
  logger.info(`Notification service listening on port ${port}`);
});

export default app;
