import { createContext } from "react";
import type { DelegatedDecisionContext, IssueThreadInteraction } from "@paperclipai/shared";

export const DelegatedRuntimeInteractions = createContext<readonly IssueThreadInteraction[]>([]);

export function DelegatedDecisionStatus({ delegation, status, recipientName }: {
  delegation: DelegatedDecisionContext; status: string; recipientName?: string;
}) {
  const label = recipientName ?? (delegation.level === "pm" ? "專案 PM" : "代理決策者");
  const text = delegation.deliveryError ? `交給 ${label} 的請求未能送達，仍待決議`
    : status === "pending" ? delegation.level === "human" ? "等待你決定" : `已交 ${label}`
      : status === "accepted" || status === "approved" ? "已依委任批准"
        : status === "answered" ? "已依委任回答" : status === "rejected" ? "已退回修正" : "請求已結束";
  return <p className="text-sm text-muted-foreground" role="status">{text}</p>;
}
