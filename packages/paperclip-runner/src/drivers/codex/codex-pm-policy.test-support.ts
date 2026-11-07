import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { admitCodexPmHook } from "./codex-pm-policy.js";
import { createIsolatedCodexAppServerArgs, createSecuredCodexThreadParams } from "./codex-security-config.js";
import { resolvePinnedCodexCommand } from "./codex-command.js";

/** Real pinned Codex, local fake Responses only; no credentials or model inference. */
export async function qualifyCodexPmPolicy() {
  const root = mkdtempSync(join(tmpdir(), "codex-pm-offline-"));
  const home = join(root, "home"), cwd = join(root, "workspace");
  mkdirSync(home); mkdirSync(cwd);
  const requests: Array<Record<string, any>> = [];
  const replies: Array<Record<string, any>> = [];
  const scriptedCalls = [
    { type: "function_call", id: "fc1", call_id: "c1", name: "exec_command",
      arguments: JSON.stringify({ cmd: `touch ${cwd}/UNAUTHORIZED` }) },
    { type: "custom_tool_call", id: "fc2", call_id: "c2", name: "apply_patch",
      input: `*** Begin Patch\n*** Add File: ${cwd}/UNAUTHORIZED_PATCH\n+bad\n*** End Patch` },
    { type: "function_call", id: "fcspawn", call_id: "cspawn", namespace: "collaboration", name: "spawn_agent",
      arguments: JSON.stringify({ task_name: "forbidden", message: "Return OFFLINE ONLY" }) },
    { type: "function_call", id: "fcstdin", call_id: "cstdin", name: "write_stdin",
      arguments: JSON.stringify({ session_id: 1, chars: "touch UNAUTHORIZED_STDIN\n" }) },
    { type: "function_call", id: "fcexternal", call_id: "cexternal", name: "mcp__external__send_message",
      arguments: JSON.stringify({ message: "Must not be sent" }) },
    { type: "custom_tool_call", id: "fc3", call_id: "c3", namespace: "functions", name: "exec",
      input: 'const result = await tools.create_task({title: "Offline dispatch only"}); text(result);' },
  ];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const count = requests.length;
    requests.push(JSON.parse(body));
    const item = scriptedCalls[count];
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (value: Record<string, unknown>) => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    event({ type: "response.created", response: { id: `r${count}`, status: "in_progress" } });
    if (item) {
      event({ type: "response.output_item.added", output_index: 0, item });
      event({ type: "response.output_item.done", output_index: 0, item });
    }
    event({ type: "response.completed", response: { id: `r${count}`, status: "completed", output: item ? [item] : [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  writeFileSync(join(home, "config.toml"), [
    'model_provider="offline"', 'model="gpt-6-astra"', "[model_providers.offline]", 'name="Offline"',
    `base_url="http://127.0.0.1:${address.port}"`, 'wire_api="responses"', "requires_openai_auth=false",
  ].join("\n"));
  const environment = { PATH: process.env.PATH!, HOME: home, CODEX_HOME: home };
  const command = resolvePinnedCodexCommand();
  const args = createIsolatedCodexAppServerArgs(environment, [], undefined, [], false, true, ["create_task"]);
  const child = spawn(command, args, { env: environment, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const stopped = new Promise(resolve => child.once("exit", resolve));
  let stderr = "", sequence = 0;
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let resolveTurn!: () => void;
  const ended = new Promise<void>(resolve => { resolveTurn = resolve; });
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.id != null && !message.method) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    } else if (message.method === "item/tool/call") {
      replies.push(message.params);
      send({ id: message.id, result: { contentItems: [{ type: "inputText", text: "Offline fixture accepted" }], success: true } });
    } else if (message.method === "turn/completed") resolveTurn();
  });
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const timeout = setTimeout(() => {
    for (const request of pending.values()) request.reject(new Error(`offline qualification timed out: ${stderr}`));
    resolveTurn(); child.kill("SIGTERM");
  }, 15000);
  try {
    await rpc("initialize", { clientInfo: { name: "pm_offline_probe", version: "1" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized", params: {} });
    await admitCodexPmHook({ request: rpc }, ["create_task"]);
    const opened = await rpc("thread/start", {
      ...createSecuredCodexThreadParams(cwd, "default", true, false, environment, true),
      model: "gpt-6-astra", approvalPolicy: "never", dynamicTools: [{ name: "create_task", description: "Offline fixture only",
        inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } }],
    });
    await rpc("turn/start", { threadId: opened.thread.id, input: [{ type: "text", text: "Offline protocol qualification only" }] });
    await ended;
    assert.equal(replies.length, 1, stderr);
    assert.equal(replies[0].tool, "create_task");
    assert(!existsSync(join(cwd, "UNAUTHORIZED")));
    assert(!existsSync(join(cwd, "UNAUTHORIZED_PATCH")));
    assert(!existsSync(join(cwd, "UNAUTHORIZED_STDIN")));
    const deniedOutputs = requests.flatMap(request => request.input.filter((item: Record<string, unknown>) =>
      item.type === "function_call_output" || item.type === "custom_tool_call_output"));
    assert(deniedOutputs.some(item => item.call_id === "cspawn" && item.output.includes("PM_TOOL_DENIED")));
    assert(deniedOutputs.some(item => item.call_id === "c1" && item.output.includes("unsupported")));
    assert(deniedOutputs.some(item => item.call_id === "c2" && item.output.includes("PM_TOOL_DENIED")));
    for (const callId of ["cstdin", "cexternal"]) {
      assert(deniedOutputs.some(item => item.call_id === callId
        && /unsupported|PM_TOOL_DENIED/.test(item.output)));
    }
    return { passed: true, dynamicCalls: replies.map(reply => reply.tool), unauthorizedFilesCreated: false, deniedOutputs };
  } finally {
    clearTimeout(timeout);
    child.stdin.end(); child.kill("SIGTERM");
    await stopped;
    lines.close(); server.close();
    rmSync(root, { recursive: true, force: true });
  }
}
