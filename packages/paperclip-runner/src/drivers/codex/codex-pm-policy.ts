import type { CodexAppServerTransport } from "./app-server-transport.js";
import { codexPmHookCommand } from "./codex-security-config.js";

/** Register only our exact restrictive hook in the disposable runner home.
 * Never trust a user/project/plugin hook or disable Codex's hook trust checks. */
export async function admitCodexPmHook(
  transport: Pick<CodexAppServerTransport, "request">,
  toolNames: readonly string[],
): Promise<void> {
  const key = "/<session-flags>/config.toml:pre_tool_use:0:0";
  const command = codexPmHookCommand(toolNames);
  const inspect = async () => {
    const result = await transport.request("hooks/list", { cwds: [] });
    const rows = Array.isArray(result.data) ? result.data : [];
    const hooks = rows.flatMap(row => Array.isArray(row.hooks) ? row.hooks : []);
    const matching = hooks.filter(hook => hook.key === key);
    if (matching.length !== 1) throw new Error("codex_pm_hook_missing_or_ambiguous");
    const hook = matching[0];
    if (hook.source !== "sessionFlags" || hook.command !== command || hook.matcher !== ".*"
      || hook.eventName !== "preToolUse" || hook.handlerType !== "command" || hook.async !== false
      || hook.enabled !== true || hook.timeoutSec !== 3 || !/^sha256:[a-f0-9]{64}$/.test(hook.currentHash)) {
      throw new Error("codex_pm_hook_mismatch");
    }
    return hook;
  };
  const hook = await inspect();
  if (hook.trustStatus !== "trusted") {
    await transport.request("config/value/write", {
      keyPath: `hooks.state.${JSON.stringify(key)}.trusted_hash`,
      value: hook.currentHash, mergeStrategy: "replace",
    });
  }
  const readback = await inspect();
  if (readback.trustStatus !== "trusted" || readback.currentHash !== hook.currentHash) {
    throw new Error("codex_pm_hook_trust_not_confirmed");
  }
}
