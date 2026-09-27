/**
 * Loopback stand-in for the Linear MCP server, used by the extension-method
 * golden scenario (`friction/post`). It runs on the shared loopback MCP
 * server (`testing/servers/mcp-server.ts`) and serves the three tools the
 * friction flow calls. Every `tools/call` it receives is recorded so the
 * scenario can pin what the runtime sent to the third-party service.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { startLoopbackMcpServer } from "../servers/mcp-server.ts";

export const LINEAR_ISSUE_IDENTIFIER = "GOLD-1";
export const LINEAR_MCP_TOKEN = "golden-linear-token";

export interface LinearToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  authorization: string | null;
}

export interface LinearMcpFake {
  url: string;
  calls: LinearToolCall[];
  close(): Promise<void>;
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

export function startLinearMcpFake(): LinearMcpFake {
  const calls: LinearToolCall[] = [];
  let authorization: string | null = null;
  const record = (tool: string, args: Record<string, unknown>) =>
    calls.push({ tool, arguments: args, authorization });
  const build = () => {
    const server = new McpServer({ name: "golden-linear", version: "1.0.0" });
    server.registerTool(
      "get_issue",
      {
        description: "Fetch one issue by id",
        inputSchema: z.object({ id: z.string() }),
      },
      (args) => {
        record("get_issue", args);
        return textResult({
          issue: {
            id: "issue-golden-0001",
            identifier: LINEAR_ISSUE_IDENTIFIER,
            title: "Friction checkpoint",
          },
        });
      },
    );
    server.registerTool(
      "list_comments",
      {
        description: "List an issue's comments",
        inputSchema: z.object({ issueId: z.string(), limit: z.number() }),
      },
      (args) => {
        record("list_comments", args);
        return textResult({
          comments: [
            { body: "F001 · 2026-01-01 · minor · escaped? no\n\nearlier" },
            { body: "F002 · E001 · 2026-01-02 · major · escaped? yes" },
          ],
        });
      },
    );
    server.registerTool(
      "create_comment",
      {
        description: "Create a comment on an issue",
        inputSchema: z.object({ issueId: z.string(), body: z.string() }),
      },
      (args) => {
        record("create_comment", args);
        return textResult({ comment: { id: "comment-golden-0001" } });
      },
    );
    return server;
  };
  const http = startLoopbackMcpServer(build, (request, mcp) => {
    authorization = request.headers.get("authorization");
    return mcp.fetch(request);
  });
  return { url: http.url, calls, close: () => http.close() };
}
