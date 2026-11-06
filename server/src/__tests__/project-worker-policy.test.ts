import { describe, expect, it } from "vitest";
import { projectWorkerPolicySchema } from "@paperclipai/shared";
import {
  parseProjectWorkerPolicy,
  resolveWorkerOverrides,
} from "../services/project-worker-policy.js";

const policy = parseProjectWorkerPolicy({
  mode: "enforce",
  workers: [
    { id: "opus", label: "Opus", adapterConfig: { model: "compass-opus5.5", effort: "high" } },
    { id: "sonnet", adapterConfig: { model: "compass-sonnet5.5" } },
  ],
});

describe("projectWorkerPolicySchema", () => {
  it("accepts a valid policy", () => {
    expect(policy?.workers).toHaveLength(2);
  });

  it("rejects duplicate ids, bad slugs, empty configs and unknown config keys", () => {
    const base = { mode: "enforce" as const };
    expect(
      projectWorkerPolicySchema.safeParse({
        ...base,
        workers: [
          { id: "a", adapterConfig: { model: "m" } },
          { id: "a", adapterConfig: { model: "n" } },
        ],
      }).success,
    ).toBe(false);
    expect(
      projectWorkerPolicySchema.safeParse({ ...base, workers: [{ id: "Bad Id", adapterConfig: { model: "m" } }] })
        .success,
    ).toBe(false);
    expect(
      projectWorkerPolicySchema.safeParse({ ...base, workers: [{ id: "a", adapterConfig: {} }] }).success,
    ).toBe(false);
    expect(
      projectWorkerPolicySchema.safeParse({
        ...base,
        workers: [{ id: "a", adapterConfig: { model: "m", cwd: "/tmp" } }],
      }).success,
    ).toBe(false);
  });

  it("rejects an unparseable stored value instead of bypassing the policy", () => {
    expect(() => parseProjectWorkerPolicy({ mode: "enforce", workers: "nope" })).toThrow("project_worker_policy_invalid");
    expect(parseProjectWorkerPolicy(null)).toBeNull();
  });
});

describe("resolveWorkerOverrides", () => {
  it("passes everything through without a policy or in off mode", () => {
    const config = { model: "anything", cwd: "/x" };
    expect(resolveWorkerOverrides(null, config)).toEqual({ adapterConfig: config, violations: [], changed: false });
    const off = parseProjectWorkerPolicy({ mode: "off", workers: [] });
    expect(resolveWorkerOverrides(off, config).violations).toEqual([]);
    expect(resolveWorkerOverrides(off, config).changed).toBe(false);
  });

  it("leaves configs without guarded keys alone", () => {
    const config = { cwd: "/x", env: { A: "1" } };
    expect(resolveWorkerOverrides(policy, config)).toEqual({ adapterConfig: config, violations: [], changed: false });
  });

  it("expands a listed worker id and keeps unrelated keys", () => {
    const result = resolveWorkerOverrides(policy, { worker: "opus", cwd: "/x" });
    expect(result.violations).toEqual([]);
    expect(result.changed).toBe(true);
    expect(result.adapterConfig).toEqual({ cwd: "/x", model: "compass-opus5.5", effort: "high" });
  });

  it("rejects an unknown worker id and strips guarded keys", () => {
    const result = resolveWorkerOverrides(policy, { worker: "gpt", cwd: "/x" });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].message).toContain("opus, sonnet");
    expect(result.adapterConfig).toEqual({ cwd: "/x" });
  });

  it("rejects explicit keys that conflict with the selected worker", () => {
    const result = resolveWorkerOverrides(policy, { worker: "opus", model: "compass-sonnet5.5" });
    expect(result.violations).toHaveLength(1);
    expect(resolveWorkerOverrides(policy, { worker: "opus", model: "compass-opus5.5" }).violations).toEqual([]);
  });

  it("allows an explicit model that a listed worker defines", () => {
    const result = resolveWorkerOverrides(policy, { model: "compass-sonnet5.5" });
    expect(result).toEqual({ adapterConfig: { model: "compass-sonnet5.5" }, violations: [], changed: false });
  });

  it("rejects an explicit model no worker defines, and a partial match", () => {
    expect(resolveWorkerOverrides(policy, { model: "compass-fable5" }).violations).toHaveLength(1);
    // model matches sonnet but effort is only defined on opus
    const partial = resolveWorkerOverrides(policy, { model: "compass-sonnet5.5", effort: "high" });
    expect(partial.violations.map((v) => v.key).sort()).toEqual(["effort", "model"]);
    expect(partial.adapterConfig).toEqual({});
  });

  it("forbids every guarded key when the list is empty", () => {
    const empty = parseProjectWorkerPolicy({ mode: "enforce", workers: [] });
    expect(resolveWorkerOverrides(empty, { model: "x" }).violations).toHaveLength(1);
    expect(resolveWorkerOverrides(empty, { worker: "opus" }).violations[0].message).toContain("none configured");
    expect(resolveWorkerOverrides(empty, { cwd: "/x" }).violations).toEqual([]);
  });
});
