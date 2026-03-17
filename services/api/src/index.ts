import express from "express";

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`API server listening on port ${port}`);
});

export default app;
