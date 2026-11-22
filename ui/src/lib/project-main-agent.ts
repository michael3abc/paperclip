import type { Agent } from "@paperclipai/shared";
import { BRIDGE_ADAPTER_TYPE, isBridgeMainAgent } from "@/components/task-chat/main-agent-model";

/**
 * A project's main agent is a CC Pocket Bridge agent whose `adapterConfig` carries `role: "main"`, the project id and
 * a fixed working directory, and which is the project's `leadAgentId`. The New project form creates one with the same
 * name through the ordinary agent-create API, copying host, provider and model from a main agent already on that host.
 */
export const MAIN_AGENT_EFFORT = "high";
export const MAIN_AGENT_PERMISSION_MODE = "fullAccess";
const PREFERRED_MODEL = /\/family:opus-5\.5$/;

function config(agent: Agent): Record<string, unknown> {
  return (agent.adapterConfig ?? {}) as Record<string, unknown>;
}
function configString(agent: Agent, key: string): string {
  const value = config(agent)[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Live (not terminated) project main agents. */
export function liveMainAgents(agents: readonly Agent[] | undefined): Agent[] {
  return (agents ?? []).filter(agent => agent.status !== "terminated" && isBridgeMainAgent(agent) && configString(agent, "hostId"));
}

/** Hosts that already run a main agent, most used first (ties keep list order). */
export function mainAgentHosts(agents: readonly Agent[] | undefined): string[] {
  const counts = new Map<string, number>();
  for (const agent of liveMainAgents(agents)) {
    const host = configString(agent, "hostId");
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([host]) => host);
}

/** The main agent whose host, provider and model a new one copies: Opus 5.5 when the host has it, else the first. */
export function templateMainAgent(agents: readonly Agent[] | undefined, hostId: string): Agent | null {
  const onHost = liveMainAgents(agents).filter(agent => configString(agent, "hostId") === hostId);
  return onHost.find(agent => PREFERRED_MODEL.test(configString(agent, "model"))) ?? onHost[0] ?? null;
}

const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * A suggested working directory: the usual projects folder of that host's main agents plus the project name. Empty
 * when the host's agents keep no projects folder, or the name has no letters or digits to build a folder from.
 */
export function suggestedMainAgentCwd(agents: readonly Agent[] | undefined, hostId: string, name: string): string {
  const folder = slug(name);
  if (!folder) return "";
  for (const agent of liveMainAgents(agents)) {
    if (configString(agent, "hostId") !== hostId) continue;
    const match = /^(.*\/projects)\/[^/]+/.exec(configString(agent, "cwd"));
    if (match) return `${match[1]}/${folder}`;
  }
  return "";
}

/** The folder must be an absolute path on the host, without line breaks. */
export function validMainAgentCwd(cwd: string): boolean {
  const value = cwd.trim();
  return value.length > 1 && value.length <= 4096 && !/[\0\r\n]/.test(value) && /^\//.test(value);
}

export function mainAgentBundle(name: string, projectId: string, cwd: string): Record<string, string> {
  const title = name.trim();
  return {
    "AGENTS.md": `# ${title} 主 agent

你是「${title}」專案的主 agent，以繁體中文簡明回報。你自己規劃、實作、測試與驗收，對工作負責到完成，或清楚說明阻礙。Owner 信任你的判斷，以 full access 執行你。

## 語言

- 問題卡、request、決策卡與任何要 Owner 回答的內容（題目、說明與選項）一律用繁體中文；程式碼、指令、路徑與專有名詞可保留原文。

## 開工

- 工作目錄是本專案的資料夾（見 PROJECT.md）。改程式碼前先讀 repo 的 AGENTS.md；要改程式時優先在 Git worktree 裡做，不在主 checkout 上直接動。
- 接續工作或作相關決策前，讀 memory/MEMORY.md。

## 決定權

可回復的決定由你自己做：自己選、照做、記下理由，然後繼續。回覆不以「要我…嗎」「需要你決定」收尾，也不列選單請 Owner 挑。

| 情況 | 做法 |
| --- | --- |
| 技術選項、範圍取捨、實作方式、換做法或停損 | 自己決定並執行，用一句話說選了什麼、為什麼。 |
| 你已有推薦選項 | 直接採用，不問。 |
| 真的有多個方向、各有實質代價，且你沒有明確偏好 | 開諮詢 task 給顧問（做法見 skill「Consulting」），顧問的決定就是決定。同一個分岔只問一次。 |
| 不可逆破壞、敏感資料外送、對外發送、帳號／權限擴張、正式環境變更、只有 Owner 知道的資訊 | 問 Owner：寫進 TODO 的「待 Owner」段並在 Chat 說明；其他項目照常往下做，不整個停下來等。 |

### 對外動作與額外費用（Owner 2026-11-21）

上表最後一列再加兩類，照樣問 Owner（寫進 TODO 的「待 Owner」段並在 Chat 說明，其他項目照常往下做）：

- 對外動作：對外發送、投遞、寄信或傳訊、發布到外部服務、交付給 Owner 以外的人。
- 額外費用：新增付費服務、訂閱或付費 API，或明顯超出平常用量的支出（例如大型批次、長時間跑付費模型）。已在用的訂閱與計量模型的一般用量不算。

用到付費外部 API 時，用 \`cost report\` 記錄。

## 做事方式

- TODO：每個對話有一份 \`todo\` 文件，是你的目標與待辦。用 \`<helper> todo\`（show／add／check N）維護；接到新工作先更新它，每完成一項就打勾。
- 預設由你在本 session 親自完成。獨立調查、平行模組與獨立 review 用原生 subagent（Agent 工具）；只有會與目前 session 衝突、必須長時間延續、Owner 明確要求，或平行效益明顯時才建立 task 交給 worker（依 PROJECT.md「Worker 選用」表）。
- 驗證與改動成比例：跑相關的測試或讀回確認即可；未執行、失敗與未觀察到的事項如實回報。
- 可讀專案設定與 .env 作診斷，但憑證內容不寫進留言、文件、記憶或版本庫。

## Instructions

AGENTS.md 與 PROJECT.md 由 Owner 維護；你想改時，在留言提出建議。memory/MEMORY.md 由你維護：只記已驗證的長期事實與偏好，附來源，合併重複，不寫逐回合日誌；進度與待辦留在 issue。
`,
    "PROJECT.md": `# ${title} 專案

## 識別

- Paperclip 專案 ID：${projectId}
- 工作目錄：${cwd.trim()}

## 來源與文件

（建立專案時尚未填寫。把專案的程式碼來源、設計文件與規則寫在這裡，並請 Owner 補充。）

## 邊界

（尚未設定。需要 Owner 同意的事項寫在這裡。）
`,
  };
}

export interface MainAgentRequest {
  name: string;
  projectId: string;
  hostId: string;
  cwd: string;
  agents: readonly Agent[] | undefined;
}

/** The body of POST /companies/:companyId/agents for the project's main agent. */
export function mainAgentCreateBody({ name, projectId, hostId, cwd, agents }: MainAgentRequest): Record<string, unknown> {
  const template = templateMainAgent(agents, hostId);
  const title = name.trim();
  const folder = cwd.trim();
  const provider = (template && configString(template, "provider")) || "claude";
  const model = (template && configString(template, "model")) || `${hostId}/${provider}/family:opus-5.5`;
  return {
    name: title,
    role: "engineer",
    title: `${title} 主 agent`,
    reportsTo: template?.reportsTo ?? null,
    adapterType: BRIDGE_ADAPTER_TYPE,
    adapterConfig: { role: "main", binding: "fixed", provider, hostId, model, effort: MAIN_AGENT_EFFORT,
      permissionMode: MAIN_AGENT_PERMISSION_MODE, cwd: folder, projectId },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 }, workspaceBinding: { mode: "fixed", cwd: folder } },
    instructionsBundle: { entryFile: "AGENTS.md", files: mainAgentBundle(title, projectId, folder) },
  };
}
