"use client";
import { useEffect, useState } from "react";
import { ensureMock, isMock, isPublicTeamApi } from "../../lib/api/client";
import { useLanguage } from "../language";
import { SiteFooter, SiteHeader, SkyBackground } from "../site-chrome";
export default function ApiDocs() {
  const { t } = useLanguage();
  const [ready, setReady] = useState(false), [error, setError] = useState("");
  useEffect(() => { let active = true; ensureMock().then(() => { if (active) setReady(true); }).catch((e) => { if (active) setError(String(e)); }); return () => { active = false; }; }, []);
  return <div className="app-shell"><SkyBackground /><a className="skip-link" href="#api-title">{t("Skip to content")}</a><SiteHeader /><main className="api-main"><h1 id="api-title" tabIndex={-1}>{t("API explorer")}</h1><p>{t("The original API specification and interactive documentation remain in English.")}</p><p>{isMock ? t("The backend owns GET /api/v1/dataset. This draft shows synthetic response and job examples.") : isPublicTeamApi ? t("The frontend documents the routes it uses. Custom-site jobs require team access.") : t("Connected backend contract. Verify its release and assumptions before use.")}</p>{error ? <p role="alert">{t(error)}</p> : ready ? <iframe title={t("Interactive OpenAPI documentation")} src="/api-docs/index.html" className="api-frame" /> : <p role="status">{t("Opening API documentation…")}</p>}</main><SiteFooter /></div>;
}
