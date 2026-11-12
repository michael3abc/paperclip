import { Command } from "commander";
import { addCommonClientOptions, handleCommandError, printOutput, resolveCommandContext, type BaseClientOptions } from "./common.js";

/** Thin transport: authorization, generations and idempotency are server-owned.
 * Never issue Git commands or turn a failed operation into a fresh attempt. */
export function registerManagedWorktreeCommands(workspace: Command) {
  const tree = workspace.command("tree").description("Main-managed linked Git worktree lifecycle");
  for (const action of ["inspect", "create", "register", "join", "leave", "set_default", "converge", "merge", "reopen", "retire", "recheck"] as const) {
    const command = tree.command(action).argument("<projectId>", "Project ID").argument("<workspaceId>", "Stable execution workspace ID");
    if (action !== "inspect") command.requiredOption("--payload-json <json>", "Original operation ID, expected generation and action parameters");
    addCommonClientOptions(command.action(async (projectId: string, workspaceId: string, opts: BaseClientOptions & { payloadJson?: string }) => {
      try {
        const context = resolveCommandContext(opts);
        const base = "/api/projects/" + encodeURIComponent(projectId) + "/worktrees/" + encodeURIComponent(workspaceId);
        let result;
        if (action === "inspect") result = await context.api.get(base);
        else {
          const payload: unknown = JSON.parse(opts.payloadJson!);
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Expected an operation JSON object");
          if ("action" in payload && payload.action !== action) throw new Error("Payload action conflicts with the command");
          const { action: _action, ...parameters } = payload as Record<string, unknown>;
          result = await context.api.post(base + (action === "recheck" ? "/recheck" : "/operations"),
            action === "recheck" ? parameters : { ...parameters, action });
        }
        printOutput(result, { json: context.json });
      } catch (error) { handleCommandError(error); }
    }));
  }
}
