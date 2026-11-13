"use client";
import { useEffect, useState } from "react";
import { ensureMock, isMock } from "../../lib/api/client";
export default function ApiDocs() {
  const [ready, setReady] = useState(false), [error, setError] = useState("");
  useEffect(() => { let active = true; ensureMock().then(() => { if (active) setReady(true); }).catch((e) => { if (active) setError(String(e)); }); return () => { active = false; }; }, []);
  return <main style={{ padding: 20 }}><a href="/">Back to comparison</a><h1>API explorer</h1><p>{isMock ? "Frontend proposal — NOT AGREED WITH BACKEND. All examples and job results are synthetic." : "Connected backend contract. Verify its release and assumptions before use."}</p>{error ? <p role="alert">{error}</p> : ready ? <iframe title="Interactive OpenAPI documentation" src="/api-docs/index.html" style={{ width: "100%", height: "80vh", border: 0, marginTop: 20 }} /> : <p role="status">Opening API documentation…</p>}</main>;
}
