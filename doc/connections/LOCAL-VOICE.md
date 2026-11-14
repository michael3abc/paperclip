# Local voice

Status: experimental, default-off. Phase 1 added the control plane below.
The HOM-311 slice adds a same-origin browser call: endpoint provisioning, a
media relay to Gemini Live, the `/voice` page and spoken confirmation of
low-risk comments. See "Browser calls (Gemini Live relay)" at the end.

Local voice is a second voice provider (`local_voice`) beside Speko. It reuses
the existing voice session, delivery, publication and reply machinery. It adds
a provider-neutral command, a strict browser control protocol
(`voice.control.v1`), trusted confirmation receipts and a durable operation
ledger.

## Gate

A local voice request must pass both flags:

- `enableChatConnectors`: the existing experimental flag for chat connectors
- `enableLocalVoice`: the new flag. It defaults to `false`.

If either flag is off, starts, tool calls, confirmations and operation lookups
fail with `403 local_voice_disabled`. When the gate is off, reconcile ends
live local sessions.

Work that was already accepted survives when the flag is turned off. The work
queue still delivers it after authorizing the principal again, exactly as it
does for Speko after a hangup.

## Provider port

`server/src/services/voice/voice-provider-port.ts` describes each provider
through `endpointFor`, `start`, `tool`, `end`, `reconcile` and `report`, plus a
capability record. The local provider is browser-only:

| capability | speko | local_voice |
| --- | --- | --- |
| browser | yes | yes |
| outboundPhone / inboundPhone | yes | **no** (`409 local_voice_phone_unsupported`) |
| providerMedia | yes | no |
| replyPush | yes | no: publications are pull-only through `get_updates` |
| callReports | yes | no |
| signedWebhooks | yes | no: same-origin board session plus a control token |

Local starts never contact a provider. A local session stores
`provider_session_id = local:<uuid>`. The voice runtime validates local and
Speko threads with separate patterns, so neither kind of id is accepted as the
other.

## Binding

`POST /api/companies/{companyId}/voice-sessions` with
`bindingMode: "voice_task"` selects the local provider. The server owns the
binding: it records the company, caller, endpoint, assigned agent, issue and
project on the session (`binding_mode`, `binding_project_id`). The client never
supplies these values again on later calls.

A start without `bindingMode` keeps the existing Speko path unchanged. Any
other `bindingMode` value is rejected with `400`. When a live session already
exists for the same caller and task, a second start gets
`409 voice_call_already_active` and does not preempt the first session.

The response is `201`:

```json
{
  "session": { "id": "…", "provider": "local_voice", "…": "…" },
  "media": {
    "provider": "local_voice",
    "protocol": "voice.control.v1",
    "bindingMode": "voice_task",
    "sessionId": "…",
    "generation": 1,
    "transportToken": "<43-char base64url control token, shown once>",
    "controlUrl": "/api/companies/{companyId}/voice-sessions/{sessionId}/local-tools"
  }
}
```

## Endpoints

Every endpoint requires a board session and company access. The mutating
endpoints also pass the board mutation guard, which requires a trusted same
origin.

| method and path | purpose |
| --- | --- |
| `POST …/voice-sessions` (`bindingMode: "voice_task"`) | Start a local session |
| `POST …/voice-sessions/{sessionId}/confirmations` | Create a trusted confirmation receipt (`201`) |
| `POST …/voice-sessions/{sessionId}/local-tools` | Send one `voice.control.v1` tool message |
| `GET …/voice-sessions/{sessionId}/operations/{operationId}` | Resolve an unknown submit outcome |
| `POST …/voice-sessions/{sessionId}/end` | End the session (existing route) |

### Control-message authentication

The `local-tools` route also requires the session control token in
`X-Paperclip-Voice-Session-Token`. It does not use `Authorization: Bearer`,
because any bearer header switches Paperclip to agent or API-key
authentication. The server stores only a hash of the token.

The route also rejects the following, before it calls the service:

- agent callers;
- a token that is missing or malformed;
- a content type other than `application/json` (`415`).

The route passes the original request bytes to the parser.

## `voice.control.v1`

There is exactly one frame type, which has exactly three tools. Every object is
strict, so unknown properties are rejected. No message may carry identity
fields such as `companyId`, `agentId`, `issueId`, `projectId`, `sessionId` or
an assignee.

```json
{"v":1,"type":"tool","toolCallId":"call_1","tool":"submit_request",
 "operationId":"<uuid>","confirmation":{"draftId":"<uuid>","revision":2},
 "args":{"text":"Book the train"}}
{"v":1,"type":"tool","toolCallId":"call_2","tool":"answer_question",
 "operationId":"<uuid>","args":{"interactionId":"<uuid>","answers":[{"questionId":"color","optionIds":["cobalt"]}]}}
{"v":1,"type":"tool","toolCallId":"call_3","tool":"get_updates","args":{"cursor":4,"repeat":true}}
```

The following are rejected:

- `v` missing (v0), `v: 2` or `v: "1"`
- `cancel_work`, which is out of scope
- a Speko envelope
- a body that is not JSON
- a body over 64 KiB

Error responses:

| failure | status | code |
| --- | --- | --- |
| body over 64 KiB | `413` | `voice_control_body_too_large` |
| body that is not JSON | `400` | `voice_control_invalid_json` |
| JSON that fails the schema | `422` | `voice_control_invalid_message` |

A rejected message creates no tool-call row, no delivery and no wakeup.

The fingerprint is the SHA-256 of the JSON of the validated message.

A successful response is a tool-result frame. The tool's own result is nested,
so its `status` cannot overwrite the frame status:

```json
{"v":1,"type":"tool_result","toolCallId":"call_1","status":200,
 "result":{"status":"accepted","requestId":"…","operationId":"…","receipt":{…}}}
```

## Confirmed text (no truncation, no edits)

1. The browser confirms the draft through
   `POST …/confirmations {draftId, revision, text}`. Only the caller's own
   board session can create this receipt; the voice tool channel cannot. The
   server stores the SHA-256 and the length of the text, not the text.
2. Confirmed text must be non-empty, at most 16 000 characters, and canonical:
   no leading or trailing whitespace (`voice_confirmation_not_canonical`). The
   work queue trims inbound messages into the issue comment. The canonical form
   is the only form whose confirmed hash equals the hash of the comment the
   agent receives. Interior whitespace, CRLF and Unicode are preserved exactly.
3. A newer revision supersedes older confirmed revisions of the same draft.
   The server rejects the following:

   | case | code |
   | --- | --- |
   | an older revision | `voice_confirmation_stale` |
   | the same revision with different text | `voice_confirmation_conflict` |
   | a draft that was already submitted | `voice_draft_submitted` |

4. `submit_request` must name `confirmation.{draftId,revision}`. Its text must
   match the confirmed hash and length. Otherwise the server stages nothing
   and returns one of these codes:

   | code |
   | --- |
   | `voice_confirmation_required` |
   | `voice_confirmation_superseded` |
   | `voice_confirmation_consumed` |
   | `voice_confirmation_mismatch` |

   On acceptance, the confirmation becomes `consumed` and links to the
   operation.

## Operations, idempotency and unknown outcomes

`submit_request` and `answer_question` require an `operationId`, which is a
client-generated UUID. The ledger (`chat_voice_operations`) is unique per
(company, caller, issue, conversation, conversation generation, operationId).
A transaction-scoped advisory lock serializes concurrent first submits.

| case | result |
| --- | --- |
| first call | one operation, one delivery and one durable wakeup; returns a receipt |
| same key, same content | returns the original receipt; no new delivery |
| same key, different content | `409 voice_operation_conflict` |
| unknown outcome | `GET …/operations/{operationId}` returns `{state:"not_found"}` before acceptance and the stored receipt after |

When the outcome is unknown, the client must retry with the same
`operationId`. The UI may show "saved" only together with a durable receipt.

## Updates and questions

`get_updates` uses the existing voice reply cursor. A later publication that
finishes first, a cursor that is behind or ahead, and duplicate hints lose
nothing and re-dispatch nothing. Progress is reported as `work`. It is never
returned as a final reply. Local responses never promise a phone push.

`answer_question` writes only when all of these hold:

- the question was presented to this session;
- it is a pending `ask_user_questions` interaction.

Every other case gets zero writes:

| case | result |
| --- | --- |
| not presented to this session, or its publication was withdrawn | `403` |
| `request_confirmation` (approvals) or another non-question kind | `409 voice_question_not_pending` |
| a resolved question | `409 voice_question_not_pending` |

## Revocation

Every tool call checks authorization again. These events end or deny the
session:

- the flag is turned off;
- chat connectors are turned off;
- a grant is revoked or the install is removed;
- membership is removed;
- the agent, issue, project or assignee changes;
- the session expires or ends.

The shared voice scheduler registers each local session's expiry and observes
authorization and feature changes. It performs no periodic provider inspection
for local sessions and remains quiet while no deadline or change is due.
`reconcile` is also available as an explicit maintenance operation; it marks
expired local sessions as expired and ends live sessions when the gate is off.

## Database (migration `0433_ambitious_the_order`)

All changes are additive.

`chat_voice_sessions` gains these columns:

| column | constraint |
| --- | --- |
| `binding_mode` | `null` or `'voice_task'` |
| `binding_project_id` | none |

`chat_voice_confirmations` has these constraints:

| constraint | rule |
| --- | --- |
| `state` | one of `confirmed`, `superseded`, `consumed` |
| `revision` | `revision >= 1` |
| `text_length` | 1..16000 |
| `text_sha256` | lowercase hex |
| consumed state | `consumed` ⇔ `operation_id is not null` |
| uniqueness | unique `(session_id, draft_id, revision)` |
| foreign keys | to the company (cascade) only; `session_id` is written by the server inside the authorized session transaction |

`chat_voice_operations` has these constraints:

| constraint | rule |
| --- | --- |
| `tool` | `submit_request` or `answer_question` |
| `state` | `'accepted'` |
| fingerprint | hex |
| ledger key | unique `(company_id, caller_id, issue_id, conversation_id, conversation_generation, operation_id)` |
| `confirmation_id` | unique |
| foreign keys | to the company (cascade) and the delivery |

The provider checks on `chat_endpoints` and `chat_external_principals` now
allow `'local_voice'`.

Neither new table has a foreign key to `chat_voice_sessions`. No code path
deletes a voice session; company deletion cascades to both tables. The
existing Speko upgrade test rebuilds a pre-voice schema by dropping
`chat_voice_sessions` in place, and a dependent foreign key would break that
unchanged test.

### Rollback

Disable `enableLocalVoice` first. Then end live local sessions, either through
reconcile or through `POST …/end`.

Keep the additive schema and session/operation history when rolling back the
application release. Do not remove the applied migration from the journal or
delete endpoint dependents. A database rollback requires a separately verified
pre-migration backup and a drained service; it cannot be performed by replaying
an older migration. Disabling local voice does not touch Speko rows, wire
formats, fingerprints or stored tool responses.

## Speko is unchanged

- HTTPS and signature rules are not relaxed.
- The tool definitions are byte-identical; a golden hash pins them.
- The fingerprint is still the SHA-256 of the parsed envelope.
- Speko's schema still trims text.

`spekoToolCommand` is the only addition. It maps a verified envelope to the
neutral command. A v1 control message is not a valid Speko envelope, and a
Speko envelope is not a valid v1 message.

## Not in phase 1 (slice-2 prerequisites)

The run-bound reply path does not admit `local_voice` yet. These places need
the provider added on purpose:

- the provider list in `external-chat-question-response.ts`;
- `BOUND_EXTERNAL_CHAT_PROVIDERS` in `external-chat-provider.ts`;
- `current-wake-comments.ts`;
- `PAPERCLIP_EXTERNAL_CHAT_PROVIDERS` in adapter-utils;
- chat file delivery and attachment reuse;
- the heartbeat's live-voice guidance and chat-communication guidance.

A later slice also needs these:

- endpoint provisioning. In phase 1, `POST /api/companies/{companyId}/chat-endpoints`
  rejects `provider: "local_voice"` and the create contract is unchanged, so no
  verification or activation path exists yet. Provisioning should be gated by
  `enableLocalVoice`;
- a canonical publication contract written by the publication producer:
  `replyKind`, `sourceReplyId`, `runId`, `revision`;
- media and a gateway;
- `cancel_work`.

## Tests

| file | coverage |
| --- | --- |
| `server/src/__tests__/local-voice.integration.test.ts` | Embedded Postgres, one test per acceptance row |
| `server/src/__tests__/local-voice-protocol.test.ts` | Parser, canonical text, capabilities, Speko compatibility |
| `server/src/__tests__/local-voice-routes.test.ts` | Same-origin routes on a loopback server with an ephemeral port |

## Browser calls (Gemini Live relay, HOM-311)

Owner decisions (HOM-265, 2026-11-14): voice_task mode first; a low-risk
comment may be sent after the draft is read back and the Owner says the
confirmation phrase 「確認送出」; approvals, deployment and settings changes
still need the normal UI; the agent writes a separate spoken summary; calls
warn at 10 minutes, end at 15, and the microphone pauses after 60 seconds
without speech; only the same-origin web page, not the CC Pocket app.

### Configuration

The relay is off unless both variables are set in the server environment:

| variable | meaning |
| --- | --- |
| `PAPERCLIP_LOCAL_VOICE_GATEWAY_URL` | realtime gateway base URL, `ws://` or `wss://`, no query (for example the LAN gateway `ws://192.168.66.11:8792`) |
| `PAPERCLIP_LOCAL_VOICE_GATEWAY_KEY_FILE` | file that holds the gateway client key; read at connect time, never logged or sent to the browser |
| `PAPERCLIP_LOCAL_VOICE_MODEL` | optional, default `gemini-3.8-live` |
| `PAPERCLIP_LOCAL_VOICE_NAME` | optional prebuilt voice, default `Kore` |

Both experimental flags (`enableChatConnectors`, `enableLocalVoice`) must also
be on. `GET /api/companies/{companyId}/local-voice/status` reports
`{enabled, relayConfigured}`.

### Endpoint provisioning

`POST /api/companies/{companyId}/local-voice/endpoints {"agentId"}` creates or
returns the one local voice endpoint for that agent (tool application,
`transport: "voice"` connection and `chat_endpoints` row, setup complete). It
needs a board session, a trusted origin, both flags and voice caller authority
(active non-viewer member, instance admin or local board). The generic chat
endpoint create contract still rejects `local_voice`.

A start without `issueId` reuses the caller's latest open voice task on that
endpoint or creates a new task titled 「語音對話」. Its description tells the
assigned agent to end every reply with one line `語音摘要：<two or three spoken
sentences>`.

### Relay WebSocket

`GET /api/companies/{companyId}/voice-sessions/{sessionId}/ws` (upgrade).
The upgrade listener is registered before the live-events listener. It
rejects, before upgrading:

- an Origin outside the board mutation guard's same-origin set (Host,
  `PAPERCLIP_PUBLIC_URL`, local dev origins; `X-Forwarded-Host` is not trusted);
- any `Authorization` header or query string;
- a missing caller session cookie or a caller who is not a member/admin;
- subprotocols other than exactly `paperclip.voice-relay.v1` plus one
  `pcvt.<transportToken>`;
- every condition `local-tools` checks (flags, session owner and authority,
  live state, expiry, generation, endpoint, task access, token hash).

Frames: binary browser→server is PCM16 mono 16 kHz microphone audio,
binary server→browser is PCM16 mono 24 kHz model audio, text frames are the
JSON `LocalVoiceRelayClientMessage` / `LocalVoiceRelayServerEvent` unions in
`packages/shared/src/types/voice-sessions.ts`. At most 2 relays per caller and
16 per server, and one relay per voice session (a second upgrade with the same
token gets `409`). Closing the browser socket ends the voice session.

### Model session

The relay sends a flat Live setup: audio responses, voice, zh-TW system
instruction, input and output transcription, `sessionResumption` and
`contextWindowCompression.slidingWindow`. Compass/Vertex rejects
`behavior: NON_BLOCKING`, so every tool returns immediately and later results
are pushed as new `clientContent` turns once the model finishes speaking.

| tool | effect |
| --- | --- |
| `query_task_status({identifier?})` | read-only: the voice task, its latest agent reply and the agent's open tasks, or one readable task by identifier |
| `prepare_request({text})` | creates or revises the draft (`draftId`, `revision`, fresh `operationId`) and shows it in the browser |
| `submit_request({draftId})` | sends the current draft as a comment through the existing confirmation and operation ledger |
| `get_updates()` | agent replies on the voice task since the call started |

`submit_request` succeeds only when the Owner pressed "Confirm and send" for
that revision, or when all of these hold for a spoken confirmation:

- the draft was read back: a model turn completed (not interrupted) whose
  output transcription contains at least 60% of the draft's character bigrams;
- one caller utterance started after that turn, while the model was not
  generating and the browser reported (`{"type":"playback","playing":false}`)
  that its audio had drained, so speaker echo of the model cannot confirm;
- that utterance is 「確認送出」 itself, optionally with a short acknowledgement
  such as 好 / 對 / 嗯 before it or 吧 / 喔 after it, after traditional and
  simplified normalization. Questions, refusals and sentences that merely
  contain the phrase (「請說確認送出」, 「我不想確認送出」, 「確認送出嗎」) do not
  count. Text notices injected by Paperclip are never transcription.

The relay then creates the confirmation receipt in the caller's authenticated
session (`voice.confirmation.created` audit `details.via` is `spoken_relay` or
`ui_relay`) and submits with the draft's operation id, so a retry after an
unknown outcome is idempotent. While a submit is in flight the draft cannot be
revised or discarded. No other write exists by voice.

GoAway and unexpected upstream closes reconnect with the latest resumption
handle (up to four attempts; without a handle the browser is told that context
may be lost). Microphone audio is buffered briefly during the switch. A 403 or
404 while reading replies (revoked access, ended or expired session) ends the
call.

Agent replies are found through company live events for the voice task plus
a 30-second safety check. The browser gets every new reply in full; the model
speaks the newest reply's `語音摘要：` line (or a short plain-text fallback),
once per distinct summary.

### Browser page

`/{companyPrefix}/voice` (sidebar "More" → Voice, pinnable) picks an agent
(the person's primary agent by default; `?agentId=` and `?issueId=` preselect)
and runs the call: AudioWorklet capture (context rate → 16 kHz PCM16 frames of
40 ms with echo cancellation, noise suppression and AGC) and playback
(24 kHz → context rate, flushed on barge-in), captions, the draft card,
replies, a typed fallback, a 10-minute warning and the 60-second silence
pause (model playback counts as activity). Microphone access needs a secure
context, so use the HTTPS address. A start that finds another live call on
the same voice task continues on a new voice task instead of preempting it.

### Usage

The relay logs `voice_relay_ended` with the call's summed per-turn
`usageMetadata` (Live reports usage per turn, and each turn's prompt includes
the context). Ledger metering of gateway realtime sessions and a rate-card
entry for `gemini-3.8-live` are a separate gateway change.

### Tests

| file | coverage |
| --- | --- |
| `server/src/__tests__/local-voice-relay.test.ts` | relay setup, audio, spoken and UI confirmation, refusals, resumption, limits, reply announcements, summary helpers |
| `server/src/__tests__/local-voice-relay.integration.test.ts` | embedded Postgres, loopback upgrade with a fake gateway: provisioning, rejected upgrades, spoken confirmation into one delivery, replies, end on disconnect |
| `ui/src/lib/local-voice/local-voice-call.test.ts` | browser call controller |
| `ui/src/lib/local-voice/worklets.test.ts` | capture and playback resampling, flush |

### Rollback

Unset the two gateway variables (the relay then rejects upgrades with 503) or
turn off `enableLocalVoice`. Endpoints, sessions and voice tasks are ordinary
additive rows and need no migration.
