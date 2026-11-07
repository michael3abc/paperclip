import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const acpx = dirname(require.resolve("acpx/package.json"));
const claude = dirname(require.resolve("@agentclientprotocol/claude-agent-acp/package.json"));
const { k: AcpClient } = await import(pathToFileURL(join(acpx, "dist/live-checkpoint-BSIrfgVo.js")));

// Only model responses and the owned MCP endpoint are fixtures. ACPX, Claude
// ACP, the Claude CLI/SDK, tool discovery and PreToolUse dispatch are real.
async function exerciseBoundary(enforced, decisions = false) {
  const home = await mkdtemp(join(tmpdir(), "paperclip-pm-acp-"));
  const project = join(home, "project"), config = join(home, "config");
  await mkdir(project); await mkdir(config);
  const readable = join(project, "evidence.txt"), forbidden = join(home, "outside.txt"), written = join(project, "forbidden-write.txt");
  await writeFile(readable, "allowed-evidence"); await writeFile(forbidden, "outside-evidence");
  const requests = [], results = [], errors = [];
  let attacked = false, foreignMcp = 0;
  let decisionStage = 0;
  const permissionRequests = [], elicitations = [], deliveries = [];
  const decisionCalls = [
    ["EnterPlanMode", {}],
    ["ExitPlanMode", { plan: "Owned fixture: choose one harmless implementation option." }],
    ["AskUserQuestion", { questions: [{ question: "Which harmless option?", header: "Scope", multiSelect: false,
      options: [{ label: "A", description: "Keep scope" }, { label: "B", description: "Reduce scope" }] }] }],
  ];
  const attacks = enforced ? [
    ["Bash", { command: `touch ${written}`, description: "test execution boundary" }],
    ["Write", { file_path: written, content: "forbidden" }],
    ["Edit", { file_path: readable, old_string: "allowed-evidence", new_string: "forbidden" }],
    ["Agent", { prompt: "write a file", description: "test delegation boundary", subagent_type: "general-purpose" }],
    ["Task", { prompt: "write a file", description: "test legacy delegation", subagent_type: "general-purpose" }],
    ["NotebookEdit", { notebook_path: written, new_source: "print(1)", cell_type: "code", edit_mode: "insert" }],
    ["mcp__foreign__write", { content: "forbidden" }],
    ["Read", { file_path: forbidden }],
    ["Read", { file_path: readable }],
  ] : [["Write", { file_path: written, content: "worker-write" }], ["Read", { file_path: forbidden }]];
  const server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/foreign")) foreignMcp++;
      let text = ""; for await (const part of req) text += part;
      const body = text ? JSON.parse(text) : {};
      if (req.url.startsWith("/mcp") || req.url.startsWith("/foreign")) {
        if (req.method !== "POST") { res.writeHead(405).end(); return; }
        if (body.id == null) { res.writeHead(202).end(); return; }
        const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "owned-test", version: "1" } }
          : body.method === "tools/list" ? { tools: [{ name: req.url.startsWith("/foreign") ? "write" : "get_identity", description: "Owned test tool", inputSchema: { type: "object", properties: {} } }] }
          : { content: [{ type: "text", text: "owned-test" }] };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result })); return;
      }
      if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":100}'); return; }
      if (!req.url.includes("/messages")) { res.writeHead(404).end(); return; }
      const target = JSON.stringify(body.messages).includes("PM_POLICY_PROBE");
      if (target) {
        requests.push((body.tools ?? []).map(tool => tool.name));
        for (const message of body.messages ?? []) for (const item of Array.isArray(message.content) ? message.content : []) {
          if (item.type === "tool_result") results.push(item);
        }
      }
      const selectedDecision = decisions && target ? decisionCalls[decisionStage++] : null;
      const content = selectedDecision ? [{ type: "tool_use", id: `toolu_decision_${decisionStage}`, name: selectedDecision[0], input: selectedDecision[1] }]
        : !decisions && target && !attacked ? attacks.map(([name, input], index) => ({ type: "tool_use", id: `toolu_pm_${index}`, name, input }))
        : [{ type: "text", text: "PM_POLICY_PROBE complete" }];
      if (target) attacked = true;
      const message = { id: "msg_pm_probe", type: "message", role: "assistant", model: body.model, content,
        stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } };
      if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message)); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
      content.forEach((block, index) => {
        event("content_block_start", { index, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
        event("content_block_delta", { index, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
        event("content_block_stop", { index });
      });
      event("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 50 } });
      event("message_stop", {}); res.end();
    } catch (error) { errors.push(String(error)); res.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const environment = { HOME: home, USER: process.env.USER ?? "test", PATH: process.env.PATH,
    CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "owned-test-placeholder",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", IS_SANDBOX: "1",
    PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1", PAPERCLIP_ACPX_TASK_TOOL_BRIDGE_URL: `${url}/mcp`,
    PAPERCLIP_PM_TOOL_POLICY: enforced ? JSON.stringify({ kind: "project_pm", version: 2, readRoots: [project] }) : "" };
  const client = new AcpClient({ agentCommand: process.execPath, agentArgv: [join(claude, "dist/index.js")], cwd: project,
    permissionMode: "approve-all", nonInteractivePermissions: "deny", spawnEnvironment: () => environment,
    elicitationModes: ["form"],
    ...(decisions ? { onPermissionRequest: async (params, context) => {
      permissionRequests.push(params); deliveries.push(context.responseDelivery);
      return { outcome: "allow_once" };
    } } : {}),
    mcpServers: [{ type: "http", name: "paperclip", url: `${url}/mcp`, headers: [] }, { type: "http", name: "foreign", url: `${url}/foreign`, headers: [] }],
  });
  try {
    await client.start(); const session = await client.createSession();
    await client.setSessionMode(session.sessionId, "bypassPermissions");
    await client.prompt(session.sessionId, [{ type: "text", text: "PM_POLICY_PROBE: inspect evidence." }], undefined,
      decisions ? async (params, context) => {
        elicitations.push(params); deliveries.push(context.responseDelivery);
        const properties = params.requestedSchema?.properties ?? {};
        return { action: "accept", content: Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key, schema.enum?.[0] ?? "A"])) };
      } : undefined);
    await Promise.all(deliveries);
    assert.deepEqual(errors, []); assert.equal(attacked, true);
    const tools = new Set(requests.flat());
    if (decisions) {
      assert.ok(permissionRequests.some(request => JSON.stringify(request).includes("ExitPlanMode")), "plan confirmation bypassed the host under approve-all");
      assert.ok(elicitations.length > 0, "AskUserQuestion did not reach the host");
      assert.ok(results.some(result => result.tool_use_id === "toolu_decision_3" && !result.is_error), "question answer did not return to Claude");
    } else if (enforced) {
    for (const tool of ["Read", "Glob", "Grep"]) assert.ok(tools.has(tool), `missing ${tool}`);
    for (const [tool] of attacks.slice(0, 7)) assert.equal(tools.has(tool), false, `advertised ${tool}`);
    assert.equal(foreignMcp, 0);
    for (let index = 0; index < 8; index++) assert.ok(results.some(result => result.tool_use_id === `toolu_pm_${index}` && result.is_error), `tool ${index} was not rejected`);
    assert.ok(results.some(result => result.tool_use_id === "toolu_pm_8" && !result.is_error && JSON.stringify(result.content).includes("allowed-evidence")));
    await assert.rejects(access(written)); assert.equal(await readFile(readable, "utf8"), "allowed-evidence");
    } else {
      assert.ok(tools.has("Write")); assert.ok(tools.has("Bash")); assert.ok(foreignMcp > 0);
      assert.equal(await readFile(written, "utf8"), "worker-write");
      assert.ok(results.some(result => result.tool_use_id === "toolu_pm_1" && !result.is_error && JSON.stringify(result.content).includes("outside-evidence")));
    }
  } finally {
    await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
 }

test("qualified Claude ACP denies execution under approve-all and filters MCP discovery", { timeout: 90_000 }, () => exerciseBoundary(true));
test("a shared worker retains the qualified Claude native tools without the PM policy", { timeout: 90_000 }, () => exerciseBoundary(false));
test("real Claude plan confirmation and questions reach the decision bridge under approve-all", { timeout: 90_000 }, () => exerciseBoundary(false, true));
