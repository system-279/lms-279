import { McpServer } from "@modelcontextprotocol/server";

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "lms-quiz-mcp", version: "0.0.0-phase0" });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Phase 0 疎通確認用。固定文字列を返すだけ。",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: "pong" }],
    })
  );

  return server;
}
