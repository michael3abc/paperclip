import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";

function appReturning(executeResult: unknown) {
  const gateway = { executeTool: async () => executeResult } as never;
  const app = express();
  app.use(express.json());
  app.use(mcpGatewayProtocolRoutes(gateway));
  return app;
}

async function callTool(executeResult: unknown) {
  const response = await request(appReturning(executeResult))
    .post("/mcp/gateways/gw_test")
    .set("authorization", "Bearer test-token")
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ccpocket:session_list", arguments: {} } })
    .expect(200);
  return response.body.result as Record<string, unknown>;
}

describe("named gateway tools/call structuredContent", () => {
  it("omits structuredContent when the tool returned only text content", async () => {
    const result = await callTool({ result: { content: "no sessions" } });
    expect(result).toEqual({ content: [{ type: "text", text: "no sessions" }], isError: false });
    expect("structuredContent" in result).toBe(false);
  });

  it("omits structuredContent for non-object data such as arrays or null", async () => {
    for (const data of [[{ id: "s1" }], null, "text", 3]) {
      const result = await callTool({ result: { data } });
      expect("structuredContent" in result).toBe(false);
    }
  });

  it("omits structuredContent when the result is missing entirely", async () => {
    const result = await callTool({ result: undefined });
    expect("structuredContent" in result).toBe(false);
  });

  it("passes object data through as structuredContent", async () => {
    const result = await callTool({ result: { data: { sessions: [{ id: "s1" }] } } });
    expect(result.structuredContent).toEqual({ sessions: [{ id: "s1" }] });
  });
});
