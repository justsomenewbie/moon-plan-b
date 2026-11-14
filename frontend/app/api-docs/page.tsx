"use client";
import { useEffect, useState } from "react";
import { ensureMock, isMock } from "../../lib/api/client";
import { LanguageControl, useLanguage } from "../language";
export default function ApiDocs() {
  const { t } = useLanguage();
  const [ready, setReady] = useState(false), [error, setError] = useState("");
  useEffect(() => { let active = true; ensureMock().then(() => { if (active) setReady(true); }).catch((e) => { if (active) setError(String(e)); }); return () => { active = false; }; }, []);
  return <main style={{ padding: 20 }}><a href="/">{t("Back to comparison")}</a><LanguageControl /><h1>{t("API explorer")}</h1><p>{t("The original API specification and interactive documentation remain in English.")}</p><p>{isMock ? t("Frontend proposal — NOT AGREED WITH BACKEND. All examples and job results are synthetic.") : t("Connected backend contract. Verify its release and assumptions before use.")}</p>{error ? <p role="alert">{t(error)}</p> : ready ? <iframe title={t("Interactive OpenAPI documentation")} src="/api-docs/index.html" style={{ width: "100%", height: "80vh", border: 0, marginTop: 20 }} /> : <p role="status">{t("Opening API documentation…")}</p>}</main>;
}
