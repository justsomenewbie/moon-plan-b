"use client";

import { useEffect, useId, useState } from "react";
import { ApiError } from "../lib/api/client";
import { useLanguage } from "./language";

export function useProblemFields(error: Error | string) {
  const prefix = useId();
  function fieldAttributes(path: string) {
    const index = error instanceof ApiError ? error.fields.findIndex(field => field.path === path) : -1;
    return index < 0 ? {} : { "aria-invalid": true, "aria-describedby": prefix + "-" + index } as const;
  }
  return { prefix, fieldAttributes };
}

// A timer updates the button label. Expiry re-enables manual submission.
export function useRetryCountdown(error: Error | string) {
  const until = error instanceof ApiError && error.retryAt ? Date.parse(error.retryAt) : 0;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  return Math.max(0, Math.ceil((until - Math.max(now, Date.now())) / 1000));
}

export function ApiProblemText({ error, fieldPrefix }: { error: Error | string; fieldPrefix?: string }) {
  const { t } = useLanguage();
  if (!(error instanceof ApiError)) return <>{t(typeof error === "string" ? error : error.message)}</>;
  return <>
    {error.title && error.title !== error.message && <strong className="block">{error.title}</strong>}
    {t(error.message)}
    {error.code && <span className="block">{t("API code")} · <code>{error.code}</code></span>}
    {error.hint && error.hint !== error.message && <span className="block">{t("Server guidance")} · {error.hint}</span>}
    {error.fields.map((field, i) => <span key={i} id={fieldPrefix ? fieldPrefix + "-" + i : undefined} className="block">{field.path && <><code>{field.path}</code> · </>}{field.message}</span>)}
    {error.retryAt && <span className="block">{t("Retry at or after")} <time dateTime={error.retryAt}>{error.retryAt}</time> (UTC)</span>}
  </>;
}
