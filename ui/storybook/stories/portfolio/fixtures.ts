import type { CompanyArtifact } from "@/api/artifacts";
import type { Issue, IssueThreadInteraction, PmWorkerPolicyView } from "@paperclipai/shared";

export const now = "2026-01-15T10:00:00Z";
export const task = (status: "in_progress" | "done", identifier: string, title: string): Issue => ({
  id: identifier, identifier, title, status, companyId: "demo-lab", updatedAt: new Date(now), createdAt: new Date(now),
  priority: "medium", assigneeAgentId: status === "done" ? "worker-b" : "worker-a",
  projectId: "web-app", projectWorkspaceId: null, goalId: null, parentId: null, description: null,
  workMode: "standard", reviewPolicy: null, assigneeUserId: null, checkoutRunId: null, executionRunId: null,
  executionAgentNameKey: null, executionLockedAt: null, createdByAgentId: "lead", createdByUserId: null,
  responsibleUserId: null, issueNumber: Number(identifier.split("-")[1]), requestDepth: 0, billingCode: null,
  assigneeAdapterOverrides: null, executionWorkspaceId: null, executionWorkspacePreference: null,
  executionWorkspaceSettings: null, startedAt: null, completedAt: status === "done" ? new Date(now) : null,
  cancelledAt: null, hiddenAt: null,
});
export const tasks = [task("in_progress", "DEMO-24", "Build the responsive workspace"), task("done", "DEMO-23", "Validate the data import")];

export const todoBody = [
  { type: "todo", v: 1, goal: "Launch the product workspace", stop: "Ready for review", nextId: 7 },
  ...[
    [1, "Approve the public preview", "open", true],
    [2, "Build responsive workspace", "open", false],
    [3, "Review keyboard navigation", "open", false],
    [4, "Prepare the release notes", "open", false],
    [5, "Validate the data import", "done", false],
    [6, "Define the project milestones", "done", false],
  ].map(([id, text, status, owner]) => ({ id, text, status, owner, task: null, note: null, createdAt: now, closedAt: status === "done" ? now : null })),
].map(row => JSON.stringify(row)).join("\n");

const interactionBase = {
  companyId: "demo-lab", issueId: "demo-review", continuationPolicy: "none" as const,
  createdByAgentId: "worker-a", createdByUserId: null, createdAt: now, updatedAt: now,
  resolverPolicy: "human_only" as const, requestedResolverPolicy: "human_only" as const,
  effectiveResolverPolicy: "human_only" as const, resolverPolicyProvenance: "explicit" as const,
  effectiveResolverPolicySource: "requested" as const, legacyResolverPolicyAliases: { requested: null, effective: null },
};
export const questions: IssueThreadInteraction[] = [
  { ...interactionBase, id: "layout-question", kind: "ask_user_questions", status: "answered",
    title: "Which layout should the worker use?", resolverPolicy: "anyone", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone",
    addresseeAgentId: "lead", resolvedByAgentId: "lead", resolvedAt: now,
    payload: { version: 1, questions: [{ id: "layout", prompt: "Which layout should the worker use?", selectionMode: "single", options: [{ id: "responsive", label: "Responsive grid", description: "One layout for desktop and mobile." }, { id: "fixed", label: "Fixed columns" }] }] },
    result: { version: 1, answers: [{ questionId: "layout", optionIds: ["responsive"] }] } },
  { ...interactionBase, id: "preview-approval", kind: "request_confirmation", status: "pending", title: "Approve the public preview", addresseeUserId: "demo-owner",
    payload: { version: 1, prompt: "Publish the preview for external reviewers?", detailsMarkdown: "The review build is ready. A human decides when to share it.", acceptLabel: "Approve preview", rejectLabel: "Keep private" } },
];

export const workers: PmWorkerPolicyView = {
  documentPath: "WORKERS.md", document: "", revision: "demo-revision", documentHash: "demo-hash", warnings: [],
  policy: { version: 2, defaultSelectionId: "coding", workers: [
    { agentId: "worker-a", harness: "codex_local", selections: [{ id: "coding", model: "Codex (GPT)", thinking: "high", permission: "approve-reads", speed: "standard", purpose: "Implementation" }] },
    { agentId: "worker-b", harness: "claude_local", selections: [{ id: "review", model: "Claude Sonnet", thinking: "high", permission: "approve-reads", speed: "standard", purpose: "Review & docs" }] },
  ] },
  catalog: [
    { agentId: "worker-a", name: "Worker A", harness: "codex_local", permissions: ["approve-reads"], models: [{ id: "Codex (GPT)", label: "Codex (GPT)", thinking: ["high"], speeds: ["standard"] }] },
    { agentId: "worker-b", name: "Worker B", harness: "claude_local", permissions: ["approve-reads"], models: [{ id: "Claude Sonnet", label: "Claude Sonnet", thinking: ["high"], speeds: ["standard"] }] },
  ],
};

export const modelCosts = {
  totalCents: 12840, unpriced: [], slices: [
    { key: "opus", label: "Claude Opus", cents: 6420, share: 0.5, color: "var(--chart-series-1)", models: ["Claude Opus"] },
    { key: "codex", label: "Codex (GPT)", cents: 3852, share: 0.3, color: "var(--chart-series-2)", models: ["Codex (GPT)"] },
    { key: "sonnet", label: "Claude Sonnet", cents: 2568, share: 0.2, color: "var(--chart-series-4)", models: ["Claude Sonnet"] },
  ],
};
export const projectUsage = [
  { projectId: "web-app", projectName: "web-app", costCents: 2420, inputTokens: 180000, cachedInputTokens: 920000, outputTokens: 70000, eventCount: 18, estimatedEventCount: 0 },
  { projectId: "data-pipeline", projectName: "data-pipeline", costCents: 1375, inputTokens: 120000, cachedInputTokens: 480000, outputTokens: 45000, eventCount: 12, estimatedEventCount: 0 },
  { projectId: "mobile-client", projectName: "mobile-client", costCents: 890, inputTokens: 90000, cachedInputTokens: 320000, outputTokens: 30000, eventCount: 9, estimatedEventCount: 0 },
];

function image(kind: "workspace" | "flow" | "mobile") {
  const ink = "#243344", paper = "#f1f5f9", accent = "#517bc7";
  const shapes = kind === "workspace"
    ? `<rect x="30" y="25" width="420" height="220" rx="12" fill="white"/><rect x="30" y="25" width="90" height="220" rx="12" fill="${ink}"/><path d="M145 70h270M145 95h190" stroke="${accent}" stroke-width="9"/><rect x="145" y="125" width="120" height="85" rx="8" fill="${paper}"/><rect x="280" y="125" width="135" height="85" rx="8" fill="${paper}"/>`
    : kind === "flow" ? `<path d="M100 135H380" stroke="${accent}" stroke-width="5"/>${[55, 195, 335].map((x, i) => `<rect x="${x}" y="95" width="90" height="80" rx="12" fill="white"/><text x="${x + 45}" y="140" text-anchor="middle" fill="${ink}" font-size="16">${["Collect", "Process", "Deliver"][i]}</text>`).join("")}`
    : `<rect x="175" y="15" width="130" height="240" rx="22" fill="${ink}"/><rect x="185" y="35" width="110" height="195" rx="10" fill="white"/><rect x="195" y="55" width="90" height="55" rx="6" fill="${accent}"/><path d="M200 140h70M200 160h55M200 180h70" stroke="${ink}" stroke-width="6"/>`;
  return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><rect width="480" height="270" fill="${paper}"/>${shapes}</svg>`);
}
export const artifacts: CompanyArtifact[] = [
  ["report", "Release brief.pdf", "file", "/api/attachments/demo-report/content", "application/pdf", "web-app"],
  ["workspace", "Workspace concept.svg", "image", image("workspace"), "image/svg+xml", "web-app"],
  ["flow", "Pipeline overview.svg", "image", image("flow"), "image/svg+xml", "data-pipeline"],
  ["mobile", "Mobile preview.svg", "image", image("mobile"), "image/svg+xml", "mobile-client"],
].map(([id, title, mediaKind, contentPath, contentType, project]) => ({ id, title, mediaKind, source: "attachment", previewText: null, contentPath, contentType, openPath: contentPath, downloadPath: contentPath,
  issue: { id: "demo-release", identifier: "DEMO-25", title: "Prepare the product preview" }, project: { id: project, name: project }, createdByAgent: { id: "worker-b", name: "Worker B" }, updatedAt: now, href: "/DEMO/issues/DEMO-25" })) as CompanyArtifact[];

/** A tiny real PDF, built locally; its thumbnail uses the shipped pdf.js path. */
export function demoPdf(): Uint8Array<ArrayBuffer> {
  const stream = "0.95 0.97 1 rg 0 0 480 270 re f 0.14 0.2 0.27 rg BT /F1 26 Tf 36 208 Td (Demo Lab) Tj 0 -42 Td /F1 18 Tf (Release brief) Tj 0 -40 Td /F1 12 Tf (A workspace built for clear decisions.) Tj 0 -26 Td (Plan. Coordinate. Review. Deliver.) Tj ET 0.32 0.48 0.78 rg 36 40 310 8 re f";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 270] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
