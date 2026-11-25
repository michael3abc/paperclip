import { forbidden } from "../errors.js";

/**
 * HOM-611: board-granted, default-off permission that lets an agent set the
 * fixed working directory (runtimeConfig.workspaceBinding) of another CC
 * Pocket agent. It lives in agents.permissions (no migration). Only the board
 * changes it, through PATCH /api/agents/:id/permissions; every other
 * permissions writer keeps the saved value, and a new agent never starts with it.
 */
export const FIXED_WORKSPACE_PERMISSION_KEY = "canConfigureFixedWorkspace";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function holdsFixedWorkspacePermission(permissions: unknown): boolean {
  return record(permissions)[FIXED_WORKSPACE_PERMISSION_KEY] === true;
}

/**
 * Keeps the saved grant on an ordinary permissions write. A write that tries to
 * change it is refused unless the caller is the board permissions route.
 */
export function preserveFixedWorkspacePermission(
  existing: unknown,
  incoming: Record<string, unknown>,
  options?: { allowGrantChange?: boolean },
): Record<string, unknown> {
  const previous = record(existing);
  const next = { ...incoming };
  const saved = previous[FIXED_WORKSPACE_PERMISSION_KEY] === true;
  if (Object.hasOwn(next, FIXED_WORKSPACE_PERMISSION_KEY)) {
    const requested = next[FIXED_WORKSPACE_PERMISSION_KEY] === true;
    if (requested !== saved && !options?.allowGrantChange) {
      throw forbidden("Only the board can change whether an agent may set fixed working directories.", {
        code: "agent_fixed_workspace_permission_board_only",
      });
    }
    // An explicit false survives merge-style writers that spread the saved record.
    next[FIXED_WORKSPACE_PERMISSION_KEY] = requested;
    return next;
  }
  if (Object.hasOwn(previous, FIXED_WORKSPACE_PERMISSION_KEY)) next[FIXED_WORKSPACE_PERMISSION_KEY] = saved;
  return next;
}

/** A new agent never inherits or requests the grant; the board turns it on afterwards. */
export function withoutInitialFixedWorkspacePermission<T>(permissions: T): T {
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return permissions;
  if (!Object.hasOwn(permissions, FIXED_WORKSPACE_PERMISSION_KEY)) return permissions;
  const { [FIXED_WORKSPACE_PERMISSION_KEY]: _dropped, ...rest } = permissions as Record<string, unknown>;
  return rest as T;
}
