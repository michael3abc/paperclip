import { afterEach, describe, expect, it, vi } from "vitest";
import { KIMI_DISTRIBUTION_CLOSURE_SHA256 } from "./kimi-closure-pins.js";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "./generated-profiles.js";
import { assertAcpxProfileReleased, resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { assertAcpxExecutionAdmission, bindAcpxCandidateAdmission, parseAcpxCandidateAdmission, parseAcpxCandidateStartupAdmission, type AcpxCandidateAdmission } from "./candidate-admission.js";
import historicalKimi from "../../../test/fixtures/kimi-profile-v16-identity.json" with { type: "json" };
import { verifyAcpxProfileInstallation } from "./profile-installation.js";
import { AcpxRuntimeHost } from "./runtime-host.js";
import * as integrity from "./installation-integrity.js";

vi.mock("./installation-integrity.js", async importOriginal => ({
  ...await importOriginal<typeof import("./installation-integrity.js")>(),
  verifyNativeAcpxInstallation: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

const now = 1_800_000_000_000;
const expected = { companyId: "company-candidate", agent: "antigravity", model: "gemini-3.8-flash-low" };
const candidate = (): AcpxCandidateAdmission => ({ schema: "paperclip.acpx-candidate-admission.v1", ...expected, agent: "antigravity",
  profileDigest: resolveQualifiedAcpxProfile("antigravity", expected.model).commandDigest,
  nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS["darwin-arm64"].closureSha256}`,
  platform: "darwin", architecture: "arm64", expiresAt: now + 60_000 });

describe("operator candidate execution admission", () => {
  it("binds an exact company/model/profile/native closure without changing release admission", () => {
    const source = candidate();
    const value = parseAcpxCandidateAdmission(source, expected, now);
    expect(value).toEqual(source);
    expect(value).not.toBe(source);
    expect(() => assertAcpxProfileReleased("antigravity")).toThrow("qualification is pending");
    expect(() => assertAcpxExecutionAdmission(resolveQualifiedAcpxProfile("antigravity", expected.model))).toThrow("qualification is pending");
  });

  it.each([
    { companyId: "another-company" }, { agent: "codex" }, { model: "gemini-3.8-flash-high" },
    { profileDigest: `sha256:${"a".repeat(64)}` }, { nativeClosureDigest: `sha256:${"b".repeat(64)}` },
    { platform: "linux" }, { architecture: "x64" }, { expiresAt: now }, { expiresAt: now + 86_400_001 },
    { expiresAt: "1800000060000" }, { unknown: true }, { runId: "injected-run" }, { model: "auto" },
  ])("rejects mismatched or broadened authority %j", change => {
    expect(() => parseAcpxCandidateAdmission({ ...candidate(), ...change }, expected, now)).toThrow(expect.objectContaining({ code: "ACPX_CANDIDATE_ADMISSION_INVALID" }));
  });

  it("binds the exact linux-x64 closure for Antigravity and keeps each platform's closure separate", () => {
    const linux = { ...candidate(), platform: "linux", architecture: "x64", nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS["linux-x64"].closureSha256}` } as AcpxCandidateAdmission;
    expect(parseAcpxCandidateAdmission(linux, expected, now)).toEqual(linux);
    expect(ANTIGRAVITY_DISTRIBUTION_PINS["linux-x64"].closureSha256).not.toBe(ANTIGRAVITY_DISTRIBUTION_PINS["darwin-arm64"].closureSha256);
    for (const change of [{ nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS["darwin-arm64"].closureSha256}` }, { platform: "darwin" }, { architecture: "arm64" }, { architecture: "arm64", platform: "linux" }]) {
      expect(() => parseAcpxCandidateAdmission({ ...linux, ...change }, expected, now)).toThrow(expect.objectContaining({ code: "ACPX_CANDIDATE_ADMISSION_INVALID" }));
    }
    expect(() => parseAcpxCandidateAdmission({ ...candidate(), nativeClosureDigest: linux.nativeClosureDigest }, expected, now)).toThrow();
    const profile = resolveQualifiedAcpxProfile("antigravity", expected.model);
    const startup = bindAcpxCandidateAdmission({ ...linux, expiresAt: Date.now() + 60_000 }, { runId: "actual-run", normalizedSessionId: "actual-session" });
    if (process.platform === "linux" && process.arch === "x64") expect(() => assertAcpxExecutionAdmission(profile, startup)).not.toThrow();
    else expect(() => assertAcpxExecutionAdmission(profile, startup)).toThrow();
  });

  it("binds actual startup run/session and refuses replay against another identity", () => {
    const current = { ...candidate(), expiresAt: Date.now() + 60_000 };
    const startup = bindAcpxCandidateAdmission(current, { runId: "actual-run", normalizedSessionId: "actual-session" });
    expect(parseAcpxCandidateStartupAdmission(startup, { ...expected, runId: "actual-run", normalizedSessionId: "actual-session" })).toEqual(startup);
    for (const identity of [{ runId: "other-run" }, { normalizedSessionId: "other-session" }, { model: "other-model" }]) {
      expect(() => parseAcpxCandidateStartupAdmission(startup, { ...expected, ...identity })).toThrow();
    }
    expect(() => parseAcpxCandidateStartupAdmission({ ...startup, trusted: true }, expected)).toThrow();
    expect(() => parseAcpxCandidateStartupAdmission(startup, expected, startup.expiresAt)).toThrow();
  });

  it("permits only the pinned native candidate at the execution exception", () => {
    const startup = bindAcpxCandidateAdmission({ ...candidate(), expiresAt: Date.now() + 60_000 }, { runId: "actual-run", normalizedSessionId: "actual-session" });
    const profile = resolveQualifiedAcpxProfile("antigravity", expected.model);
    if (process.platform === "darwin" && process.arch === "arm64") expect(() => assertAcpxExecutionAdmission(profile, startup)).not.toThrow();
    else expect(() => assertAcpxExecutionAdmission(profile, startup)).toThrow();
    expect(() => assertAcpxExecutionAdmission(resolveQualifiedAcpxProfile("codex", expected.model), startup)).toThrow();
    expect(() => assertAcpxExecutionAdmission({ ...profile, commandDigest: `sha256:${"c".repeat(64)}` }, startup)).toThrow();
    for (const agent of ["codex", "claude", "grok", "cursor", "pi", "copilot"] as const) {
      expect(() => assertAcpxExecutionAdmission(resolveQualifiedAcpxProfile(agent, "caller-selected-model"))).not.toThrow();
    }
  });
});

describe("candidate installation remains cryptographically verified", () => {
  const profile = resolveQualifiedAcpxProfile("antigravity", "gemini-3.8-flash-low");
  const admission = (target: "darwin-arm64" | "linux-x64" = "darwin-arm64") => bindAcpxCandidateAdmission({ schema: "paperclip.acpx-candidate-admission.v1", companyId: "company-candidate", agent: "antigravity", model: profile.qualificationModel,
    profileDigest: profile.commandDigest, nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS[target].closureSha256}`,
    platform: target === "linux-x64" ? "linux" : "darwin", architecture: target === "linux-x64" ? "x64" : "arm64", expiresAt: Date.now() + 60_000 }, { runId: "run-candidate", normalizedSessionId: "session-candidate" });

  it.each([["darwin", "arm64", "darwin-arm64", []], ["linux", "x64", "linux-x64", ["--uid="]]] as const)("delegates the admitted exception on %s-%s to the exact complete native closure verifier", async (platform, arch, target, fixedArguments) => {
    if (process.platform !== platform || process.arch !== arch) return;
    const native = { commandDigest: "native-closure-verifier-result" } as integrity.VerifiedAcpxInstallation;
    vi.mocked(integrity.verifyNativeAcpxInstallation).mockResolvedValue(native);
    const result = await verifyAcpxProfileInstallation(profile, admission(target));
    expect(result.commandDigest).toBe(profile.commandDigest);
    expect(integrity.verifyNativeAcpxInstallation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      expectedClosureSha256: ANTIGRAVITY_DISTRIBUTION_PINS[target].closureSha256,
      executable: "agy_acp_server.par", fixedArguments: [...fixedArguments],
    }));
  });

  it("denies absent, altered, or other-provider authority before any native files are opened", async () => {
    vi.mocked(integrity.verifyNativeAcpxInstallation).mockClear();
    await expect(verifyAcpxProfileInstallation(profile)).rejects.toMatchObject({ code: "ACPX_PROFILE_QUALIFICATION_PENDING" });
    await expect(verifyAcpxProfileInstallation(profile, { ...admission(), model: "gemini-3.8-flash-high" })).rejects.toMatchObject({ code: "ACPX_CANDIDATE_ADMISSION_INVALID" });
    await expect(verifyAcpxProfileInstallation(resolveQualifiedAcpxProfile("codex", profile.qualificationModel), admission())).rejects.toMatchObject({ code: "ACPX_CANDIDATE_ADMISSION_INVALID" });
    expect(integrity.verifyNativeAcpxInstallation).not.toHaveBeenCalled();
  });

  it("rejects a candidate session mismatch before installation, credentials, or runtime acquisition", async () => {
    const verifyInstallation = vi.fn(), openRuntime = vi.fn();
    await expect(AcpxRuntimeHost.open({ candidateAdmission: admission(), runtimeDirectory: "/unused", normalizedSessionId: "another-session", workingDirectory: "/unused", agent: "antigravity", model: profile.qualificationModel,
      permissionMode: "deny-all", providerPolicy: { readOnly: true } }, { verifyInstallation, openRuntime, retainAdmissionCleanup: () => {}, reportRetainedCleanupFailure: () => {} })).rejects.toMatchObject({ code: "ACPX_CANDIDATE_ADMISSION_INVALID" });
    expect(verifyInstallation).not.toHaveBeenCalled();
    expect(openRuntime).not.toHaveBeenCalled();
  });
});


describe("trusted Kimi candidate admission", () => {
  const kimiExpected = { companyId: "company-kimi", agent: "kimi", model: "kimi-for-coding" };
  const kimiCandidate = (target: "darwin-arm64" | "linux-x64"): AcpxCandidateAdmission => ({
    schema: "paperclip.acpx-candidate-admission.v1", ...kimiExpected, agent: "kimi",
    profileDigest: resolveQualifiedAcpxProfile("kimi", kimiExpected.model).commandDigest,
    nativeClosureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256[target]}`,
    platform: target === "darwin-arm64" ? "darwin" : "linux",
    architecture: target === "darwin-arm64" ? "arm64" : "x64", expiresAt: now + 60_000,
  });

  it.each(["darwin-arm64", "linux-x64"] as const)("binds only the current pending Kimi profile and exact %s closure", target => {
    const profile = resolveQualifiedAcpxProfile("kimi", kimiExpected.model);
    if (profile.qualificationStatus === "pending") {
      expect(parseAcpxCandidateAdmission(kimiCandidate(target), kimiExpected, now)).toEqual(kimiCandidate(target));
      expect(() => assertAcpxProfileReleased("kimi")).toThrow("qualification is pending");
      expect(() => assertAcpxExecutionAdmission(profile)).toThrow("qualification is pending");
    } else {
      expect(profile.agentProfileVersion).toBe(17);
      expect(() => assertAcpxProfileReleased("kimi")).not.toThrow();
      expect(() => assertAcpxExecutionAdmission(profile)).not.toThrow();
      expect(() => parseAcpxCandidateAdmission(kimiCandidate(target), kimiExpected, now)).toThrow();
      expect(() => parseAcpxCandidateAdmission({ ...kimiCandidate(target), profileDigest: historicalKimi.commandDigest }, kimiExpected, now)).toThrow();
    }
    const other = target === "darwin-arm64" ? "linux-x64" : "darwin-arm64";
    for (const change of [
      { companyId: "foreign-company" }, { agent: "antigravity" }, { model: "another-model" },
      { model: "auto" }, { model: "default" }, { model: " kimi-for-coding" },
      { profileDigest: `sha256:${"0".repeat(64)}` },
      { nativeClosureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256[other]}` },
      { platform: "linux", architecture: "arm64" }, { platform: "darwin", architecture: "x64" },
      { expiresAt: now }, { expiresAt: now + 86_400_001 }, { expiresAt: "1800000060000" },
      { unknown: true }, { runId: "injected-run" },
    ]) expect(() => parseAcpxCandidateAdmission({ ...kimiCandidate(target), ...change }, kimiExpected, now)).toThrow(expect.objectContaining({ code: "ACPX_CANDIDATE_ADMISSION_INVALID" }));
  });

  it.each(["darwin-arm64", "linux-x64"] as const)("requires the exact actual host and startup identity for %s", target => {
    const profile = resolveQualifiedAcpxProfile("kimi", kimiExpected.model);
    const source = { ...kimiCandidate(target), expiresAt: Date.now() + 60_000 };
    const identity = { runId: "kimi-run", normalizedSessionId: "kimi-session" };
    const startup = profile.qualificationStatus === "pending" ? bindAcpxCandidateAdmission(source, identity) : { ...source, ...identity };
    if (profile.qualificationStatus !== "pending") expect(() => bindAcpxCandidateAdmission(source, identity)).toThrow();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
    try {
      Object.defineProperty(process, "platform", { ...platform, value: startup.platform });
      Object.defineProperty(process, "arch", { ...architecture, value: startup.architecture });
      if (profile.qualificationStatus === "pending") expect(() => assertAcpxExecutionAdmission(profile, startup)).not.toThrow();
      else {
        expect(() => assertAcpxExecutionAdmission(profile)).not.toThrow();
        expect(() => assertAcpxExecutionAdmission(profile, startup)).toThrow();
      }
      for (const identity of [{ runId: "foreign-run" }, { normalizedSessionId: "foreign-session" }, { model: "foreign-model" }]) {
        expect(() => parseAcpxCandidateStartupAdmission(startup, { ...kimiExpected, runId: "kimi-run", normalizedSessionId: "kimi-session", ...identity })).toThrow();
      }
      expect(() => assertAcpxExecutionAdmission({ ...profile, commandDigest: `sha256:${"f".repeat(64)}` }, startup)).toThrow();
      expect(() => parseAcpxCandidateStartupAdmission(startup, kimiExpected, startup.expiresAt)).toThrow();
      for (const [os, arch] of [["win32", "x64"], ["linux", "arm64"], ["darwin", "x64"],
        target === "darwin-arm64" ? ["linux", "x64"] : ["darwin", "arm64"]]) {
        Object.defineProperty(process, "platform", { ...platform, value: os });
        Object.defineProperty(process, "arch", { ...architecture, value: arch });
        expect(() => assertAcpxExecutionAdmission(profile, startup)).toThrow();
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
      Object.defineProperty(process, "arch", architecture);
    }
  });
});
