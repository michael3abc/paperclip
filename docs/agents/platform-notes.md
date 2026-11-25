# platform-notes

Moved verbatim from `AGENTS.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. Web Push, host quotas, Runner/PRP contract, Dot assignment, artifact delivery, data-path inventory

Web Push uses account-owned preferences/subscriptions and company-scoped delivery
receipts. Keep `/api/push` restricted to authenticated human sessions; local-board
and agent keys are not subscription identities. Producers must enqueue inside
their persistence transaction and use the existing delivery coordinator. Preserve
source-event/device idempotency, current task/decision authorization, fixed
coalescing windows and idle zero-polling. Never log endpoints, encryption keys or
notification content. See `doc/DEVELOPING.md` (Web Push) and `doc/DATABASE.md`.
Keep the human-only OpenAPI registrations aligned with shared push request
validators. Unrelated audit writes retain their existing caller transaction.
- Completion admission waits for outstanding tools and excludes new tools while pending. Forced cleanup must preserve unresolved receipts and distinguish local Runner shutdown from external-provider termination.
- External-provider assignments, settled tool results, and input responses are authoritative PRP execution data. Preserve their complete payloads under the transport/outbox bounds; never apply diagnostic string truncation to them.
- Dot assignment reads must include current server-owned tool-use guidance. Returning an allowed result to the same accepted task is ordinary completion; task text cannot grant owner authority. Preserve user restrictions, approval gates, and unresolved-operation fences, and require an actual completion receipt rather than a reply only in the external conversation.

6. Attach inspectable generated artifacts.
When your task produces a user-inspectable deliverable file, follow the Paperclip skill's "Generated Artifacts and Work Products" workflow before final disposition. In this repo, prefer the self-contained skill helper at `skills/paperclip/scripts/paperclip-upload-artifact.sh` so the file is available through the Paperclip API, create/update an artifact work product when the file is the deliverable, link the uploaded artifact in the final issue comment, and then set status. Do not rely on local filesystem paths as the only access path. If an important file intentionally remains workspace-only, create/update a work product with `metadata.resourceRef.kind: "workspace_file"` and a workspace-relative path, then name that work product and path in the final comment. Treat browse/search as a fallback for recovering workspace files, not the preferred deliverable path. See `doc/AGENT-ARTIFACTS.md` for details and `.mp4`/`.webm` examples.

- **Telemetry** is the Paperclip first-party event system. It is opt-out and it sends data to a Paperclip endpoint by default. Its paths are:
  - `packages/shared/src/telemetry/`
  - the generated contract `packages/shared/src/telemetry/generated/paperclip-telemetry.ts`
  - each caller of `packages/shared/src/telemetry/events.ts` or `packages/shared/src/telemetry/client.ts`
- **Observability** is the OpenTelemetry trace path. An operator must set an OTLP endpoint. Until an operator sets the endpoint, the tracer is a no-operation. Its paths are:
  - `server/src/instrumentation.ts`
  - `doc/observability.md`
  - `packages/adapter-utils/src/duplex-observability.ts`
  - `server/src/services/duplex-observability-recorder.ts`
  - the span attributes in `packages/adapter-utils/src/acpx-engine/startup-timing.ts`
- **The run log** holds rows in the local `heartbeat_run_events` table. The data stays in the instance database. Its paths are:
  - `doc/run-log-events.md`
  - `packages/db/src/schema/heartbeat_run_events.ts`
  - the append path `appendRunEvent` in `server/src/services/heartbeat.ts`

Host subscription quotas are an explicit operator feature, enabled only with
PAPERCLIP_HOST_SUBSCRIPTION_QUOTAS=1. The dashboard endpoint requires instance
admin and existing company access before any host login is read. Keep these
snapshots separate from company-managed AI connections and billing. Source selection
is operator-owned and company-ID scoped: Home uses michael-server; Shopee uses
shopee-e through its finite SSH collector, reading that host's CLI logins only.
Never accept a client-selected host or fall back to local accounts after remote
failure. Cache and in-flight requests are keyed by company plus source. Poll only
while the Dashboard is visible, cache for 60 seconds, track provider work through
maintenance admission, and preserve unknown values and provider failures. Codex
window labels derive from durations, never primary/secondary position.
Business/Enterprise Codex also reports `individualLimit`: show its monthly credit
limit, provider-reported remaining percentage and reset even without ordinary
windows. RPC credit amounts are credits, not currency; an absent balance never
creates a successful `Credits: N/A` row. Unlimited credits remain explicit. Subscription
bar fill, percentage labels and accessible values all show remaining quota; warning
colors still reflect depletion. Other spending bars retain consumption semantics.
Antigravity shows only its reported quota groups; never infer Gemini quota or enable credits.
See doc/DEVELOPING.md, Host subscription quota dashboard.

## 主機終端（HOM-574）

公司 Settings → 主機終端（`/company/settings/host-terminals`）只對已登入的
human board instance admin 開放，且仍須有該公司存取權。Agent API key、JWT、
run token、board key 與 local implicit board 都不能使用。此功能提供主機使用者的
完整互動式 login shell；主機必須由 operator 在既有 company-scoped
`PAPERCLIP_CCPOCKET_HOSTS_FILE`（預設 `~/.config/paperclip-ccpocket/hosts.json`）
明確 opt-in。未設定、`enabled: false` 或不屬於該公司的主機都不開放。

在 version-1 registry 的既有 host entry 加入：

```json
{
  "id": "example-host",
  "label": "Example host",
  "companyIds": ["company-uuid"],
  "sshAlias": "ExampleHost",
  "terminal": { "enabled": true, "cwd": "/home/operator" }
}
```

本機 host 省略 `sshAlias`。`cwd` 可省略；若指定，必須是以 `/` 開頭、只含
ASCII 英數與 `/_.@+-` 的絕對路徑，最長 4096 字元。`enabled` 必須是 boolean，
terminal 不接受其他欄位。`sshAlias` 只能含英數及 `_.-`，首字元須為英數。
Client 只能選已登記的 host ID，不能提交 shell、command、cwd、SSH target 或 env。
Registry 不存在或錯誤會明確失敗，不退回本機。連線前重新讀取 registry。

`GET /api/companies/:companyId/host-terminals` 只回傳可用主機的 id、label。
`POST /api/companies/:companyId/host-terminals/:hostId/sessions` 接受空 JSON object，
回傳記憶體內的一次性 token、session id、expiry 及 wsPath。Token 綁定 company、
user、host，60 秒內須使用；只儲存 token hash，不能重播。瀏覽器連到 same-origin
`/api/companies/:companyId/host-terminals/:hostId/ws`，首個 JSON frame 為
`{ "type": "auth", "sessionId": "...", "token": "..." }`。Token 不放在 URL。
Upgrade 檢查 Origin、目前的人類 session、instance-admin role 與 active company
membership；不以 token 取代人類 cookie。反向代理須保留 Host／Cookie／Upgrade，
公開 origin 使用既有 auth public base URL（或 `PAPERCLIP_PUBLIC_URL`）。未設定公開
URL 時，只接受直接 HTTP/TLS listener 的同 origin。

Client frame 另有 `input`（data）與 `resize`（cols 2–500、rows 1–300）；server
frame 為 `ready`、`output`（data）、`closed`（reason、exitCode）。終端內容不寫入
DB、activity log 或 server log；被拒絕的 HTTP body 也走內容遮蔽規則。Activity
只記 started／ended、host、user、時間、結束原因及 exit code。Token 回應禁快取。

Linux server 使用系統 `/usr/bin/python3` 與標準函式庫 PTY，不新增原生依賴。
本機 shell 來自執行 server 的 OS 使用者資料，啟動環境只含 HOME、USER、LOGNAME、
SHELL、固定 PATH、LANG、TERM；不繼承 server 的 DATABASE_URL、provider keys 或其他
環境變數。Login profile 仍由該 OS 使用者管理。遠端使用同一乾淨環境啟動
`ssh -tt -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o ServerAliveInterval=30`
至 registry 的 alias；SSH keys/config/known_hosts 留在原主機，不複製進 Paperclip。
若指定 cwd，先在目標主機 cd，再啟動目標使用者 login shell。無主機或帳號 fallback。

每人最多四個連線（包含等待使用的 token），無輸入且無輸出 30 分鐘關閉，
單次最長 12 小時。Resize 不延長閒置期限。關閉分頁、離開頁面、WebSocket 斷線或
server shutdown 都終止 PTY session 的 shell／job-control process groups，並回收程序。
大量輸入或輸出超出有界連線緩衝會明確關閉。重連會取得新 token、開新 shell，
不重播任何輸入；長駐工作請使用 tmux。UI 提供分頁與手機 Esc／Tab／Ctrl+C／Ctrl+D／方向鍵。

Chat／task 右側面板的「+」選單也列出可用主機（`Terminal: <label>`），每次選取開一個新分頁。
這些終端由 `ui/src/lib/host-terminal-store.ts` 持有、位於 routes 之上：切換對話、公司或收起
面板不結束 shell，其他對話的「+」可接回執行中的終端；關閉分頁、重新整理或換帳號才結束。
面板只儲存終端參照，不儲存 token 或內容；重新整理後不自動開新 shell。有執行中的終端時，
Service Worker 更新不自動重新整理頁面。設定頁的終端仍在離開頁面時結束。
