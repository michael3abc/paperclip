import { useEffect, useState } from "react";
import { useAccountIdentity } from "../api/companies-query";
import { reconcilePushAccount } from "../lib/web-push";

export function PushAccountBinding() {
  const { userId, settled } = useAccountIdentity();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!settled || !userId) return; // Expiry is not an explicit sign-out.
    let cancelled = false;
    void reconcilePushAccount(userId).then(() => { if (!cancelled) setError(null); },
      reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "推播帳號同步失敗。"); });
    return () => { cancelled = true; };
  }, [userId, settled]);
  return error ? <p role="alert" className="p-2 text-sm text-destructive">{error}</p> : null;
}
