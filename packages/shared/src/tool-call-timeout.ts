/**
 * Per-connection tool call deadlines (HOM-411).
 *
 * A connection may raise the deadline of its tool calls in its `config`:
 * `callTimeoutMs` applies to every tool and `callTimeoutMsByTool` overrides it
 * for one tool name. Both are optional; an unset connection keeps the
 * built-in deadlines (10 s for an interactive call, 30 s for an approved one).
 * Values outside 1 s to 180 s are rejected when the connection is saved.
 */

export const TOOL_CALL_TIMEOUT_MIN_MS = 1_000;
export const TOOL_CALL_TIMEOUT_MAX_MS = 180_000;
export const TOOL_CALL_TIMEOUT_CONFIG_KEY = "callTimeoutMs";
export const TOOL_CALL_TIMEOUT_BY_TOOL_CONFIG_KEY = "callTimeoutMsByTool";

function isValidTimeout(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= TOOL_CALL_TIMEOUT_MIN_MS
    && value <= TOOL_CALL_TIMEOUT_MAX_MS;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Problems with a connection config's call deadlines; empty when it is valid or unset. */
export function toolCallTimeoutConfigIssues(config: unknown): string[] {
  const values = record(config);
  if (!values) return [];
  const issues: string[] = [];
  const range = `an integer from ${TOOL_CALL_TIMEOUT_MIN_MS} to ${TOOL_CALL_TIMEOUT_MAX_MS} milliseconds`;
  const all = values[TOOL_CALL_TIMEOUT_CONFIG_KEY];
  if (all !== undefined && all !== null && !isValidTimeout(all)) {
    issues.push(`${TOOL_CALL_TIMEOUT_CONFIG_KEY} must be ${range}.`);
  }
  const byTool = values[TOOL_CALL_TIMEOUT_BY_TOOL_CONFIG_KEY];
  if (byTool !== undefined && byTool !== null) {
    const entries = record(byTool);
    if (!entries) {
      issues.push(`${TOOL_CALL_TIMEOUT_BY_TOOL_CONFIG_KEY} must map tool names to ${range}.`);
    } else {
      for (const [toolName, value] of Object.entries(entries)) {
        if (!toolName.trim() || !isValidTimeout(value)) {
          issues.push(`${TOOL_CALL_TIMEOUT_BY_TOOL_CONFIG_KEY}.${toolName} must be ${range}.`);
        }
      }
    }
  }
  return issues;
}

/**
 * The deadline a connection sets for one tool, or null when it sets none.
 * Invalid stored values are ignored so an old row never breaks a call.
 */
export function configuredToolCallTimeoutMs(config: unknown, toolName: string): number | null {
  const values = record(config);
  if (!values) return null;
  const byTool = record(values[TOOL_CALL_TIMEOUT_BY_TOOL_CONFIG_KEY]);
  const toolValue = byTool?.[toolName];
  if (isValidTimeout(toolValue)) return toolValue;
  const all = values[TOOL_CALL_TIMEOUT_CONFIG_KEY];
  return isValidTimeout(all) ? all : null;
}
