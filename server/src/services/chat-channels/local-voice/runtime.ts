import { conflict } from "../../../errors.js";
import type { ChatRuntime } from "../../chat-runtime.js";
import type { ChatSdkRuntime } from "../../chat-sdk-runtime.js";
import type { ChatSdkStatePersistence } from "../../chat-sdk-state.js";
import type { EndpointRecord } from "../runtime-types.js";

export function replaceLocalVoiceChannelRuntime(runtime: ChatRuntime | ChatSdkRuntime, record: EndpointRecord, persistence: ChatSdkStatePersistence) {
  if (!("replaceVoiceEndpoint" in runtime)) throw conflict("Voice runtime is unavailable");
  return runtime.replaceVoiceEndpoint({ companyId: record.endpoint.companyId, endpointId: record.endpoint.id,
    userName: record.assignedAgentName, persistence, provider: "local_voice" });
}
