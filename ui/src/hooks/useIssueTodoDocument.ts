import { useQuery } from "@tanstack/react-query";
import type { IssueDocument } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { TODO_DOCUMENT_KEY } from "@/lib/todo-document";

const TODO_DOCUMENT_STALE_TIME_MS = 15_000;

/**
 * The conversation's `todo` document, or null when the agent has not created one (a 404 is the normal answer).
 * Keyed under queryKeys.issues.documents so document live updates refresh it when the agent edits the TODO.
 */
export function useIssueTodoDocument(issueId: string | null | undefined) {
  return useQuery<IssueDocument | null>({
    queryKey: [...queryKeys.issues.documents(issueId ?? ""), TODO_DOCUMENT_KEY],
    enabled: Boolean(issueId) && !issueId?.startsWith("chat:"),
    staleTime: TODO_DOCUMENT_STALE_TIME_MS,
    queryFn: async () => {
      try {
        return await issuesApi.getDocument(issueId!, TODO_DOCUMENT_KEY);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
}
