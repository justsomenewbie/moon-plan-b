"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiError, createJob, getJob, isMock, jobPollInterval, validateCustomWindow, validateTerrainTargetWindow, windowFromInputs } from "../lib/api/client";
import { terrainUtcNanos } from "../lib/api/terrain-summary";
import type { TerrainTarget, WindowRequest } from "../lib/api/client";
import type { Dataset } from "../lib/dataset";
import CustomSiteJob from "./custom-site-job";
import { useLanguage } from "./language";

type ResultHandler = (data: Dataset, request: WindowRequest, jobId: string) => void;
const windowInputs = (request: WindowRequest) => ({ from: request.from.slice(0, -1), to: request.to.slice(0, -1), resolution: String(request.resolutionSeconds) });

export function ApiControls({ request, target, loading, onLoad, onResult, onTerrainResult }: { request: WindowRequest; target?: TerrainTarget; loading: boolean; onLoad: (request: WindowRequest) => void; onResult: ResultHandler; onTerrainResult: (request: WindowRequest, result: { run_id: string; site_id: string }) => void }) {
  const { t } = useLanguage();
  const [error, setError] = useState("");
  const [inputs, setInputs] = useState(() => windowInputs(request));
  const previousRequest = useRef(request);
  const editedWhileLoading = useRef(false);
  useEffect(() => {
    if (loading) return;
    const previous = previousRequest.current;
    const preserveDraft = editedWhileLoading.current;
    previousRequest.current = request;
    editedWhileLoading.current = false;
    if (previous === request || preserveDraft) return;
    setInputs((current) => {
      try {
        const draft = windowFromInputs(current.from, current.to, current.resolution, isMock ? undefined : range => validateTerrainTargetWindow(range, target));
        if (terrainUtcNanos(draft.from) === terrainUtcNanos(previous.from) && terrainUtcNanos(draft.to) === terrainUtcNanos(previous.to) && draft.resolutionSeconds === previous.resolutionSeconds) return windowInputs(request);
      } catch { /* An incomplete draft stays editable. */ }
      return current;
    });
  }, [loading, request, target]);
  function changeInput(key: keyof typeof inputs, value: string) {
    // A deliberate edit back to the previous accepted value is still a new draft.
    if (loading) editedWhileLoading.current = true;
    setInputs(current => ({ ...current, [key]: value }));
  }
  const readRequest = () => windowFromInputs(inputs.from, inputs.to, inputs.resolution, isMock ? undefined : range => validateTerrainTargetWindow(range, target));
  return <><details className="request-panel"><summary>{t("Request observation windows")}</summary><p className="muted">{isMock ? t("UTC throughout. Both actions use these editable values. The proposed API limits a request to 31 days and 10,000 samples per series. Actual cadence is reported with each result.") : target?.site_ids ? t("Load observations for the two sites in this shared link using the UTC range below.") : t("Compare Odysseus and Athena over up to 31 days. The team API returns full-resolution visibility intervals for the selected UTC range.")}</p>
    <form className="request-fields" onSubmit={(event) => {
      event.preventDefault();
      try { const next = readRequest(); setError(""); onLoad(next); } catch (e) { setError(e instanceof Error ? e.message : "Invalid request."); }
    }}>
      <label className="field">{t("From · UTC")}<input name="from" type={/\.\d{4,9}Z$/.test(request.from) ? "text" : "datetime-local"} step="0.001" required value={inputs.from} onChange={(e) => changeInput("from", e.target.value)} /></label>
      <label className="field">{t("To · UTC")}<input name="to" type={/\.\d{4,9}Z$/.test(request.to) ? "text" : "datetime-local"} step="0.001" required value={inputs.to} onChange={(e) => changeInput("to", e.target.value)} /></label>
      <label className="field">{t(isMock ? "Desired step · seconds" : "Track sampling step · seconds")}<input name="resolution" type="number" min={isMock ? 60 : 3600} max={isMock ? 86400 : 2678400} step="1" required value={inputs.resolution} onChange={(e) => changeInput("resolution", e.target.value)} /></label>
      <button className="button outline" disabled={loading}>{t("Load windows")}</button>
    </form>{error ? <p role="alert">{t(error)}</p> : null}
  </details>{isMock ? <JobForm readRequest={readRequest} onResult={onResult} /> : <CustomSiteJob readRequest={() => windowFromInputs(inputs.from, inputs.to, "3600", validateCustomWindow)} onResult={onTerrainResult} />}</>;
}

function JobForm({ readRequest, onResult }: { readRequest: () => WindowRequest; onResult: ResultHandler }) {
  const { t } = useLanguage();
  const [jobId, setJobId] = useState("");
  const [error, setError] = useState("");
  const create = useMutation({ mutationFn: createJob, onSuccess: (job) => setJobId(job.jobId) });
  const job = useQuery({ queryKey: ["job", jobId, create.variables], queryFn: ({ signal }) => getJob(jobId, create.variables!, signal), enabled: Boolean(jobId && create.variables), refetchInterval: (query) => query.state.error ? false : jobPollInterval(query.state.data), refetchOnWindowFocus: false });
  const busy = create.isPending || Boolean(jobId) && !job.error && job.data?.status !== "done" && job.data?.status !== "failed";
  return <details className="request-panel"><summary>{isMock ? t("Try a synthetic job") : t("Request a custom lunar location")}</summary>
    <p className="muted">{isMock ? t("This simulates queued, running and completed responses. It returns the fictional fixture; entered coordinates are not computed.") : t("The backend computes the observations. Confirm the coordinate frame and elevation datum with the data producer.")} {t("Uses the request range above.")}</p>
    <form className="request-fields" onSubmit={(event) => {
      event.preventDefault(); const fields = new FormData(event.currentTarget);
      try {
        const request = readRequest(); setError(""); setJobId("");
        create.mutate({ ...request, location: { latitudeDeg: Number(fields.get("latitude")), longitudeEastDeg: Number(fields.get("longitude")), elevationKm: Number(fields.get("elevation")), frame: String(fields.get("frame")), elevationDatum: String(fields.get("datum")) } });
      } catch (e) { setError(e instanceof Error ? e.message : "Invalid request range above."); }
    }}>
      <label className="field">{t("Latitude · degrees")}<input name="latitude" type="number" min="-90" max="90" step="any" required defaultValue="0" /></label>
      <label className="field">{t("East longitude · degrees")}<input name="longitude" type="number" min="-180" max="180" step="any" required defaultValue="0" /></label>
      <label className="field">{t("Elevation · km")}<input name="elevation" type="number" min="-100" max="100" step="any" required defaultValue="0" /></label>
      <label className="field">{t("Coordinate frame")}<input name="frame" required maxLength={2000} defaultValue={isMock ? "SYNTHETIC-FIXTURE" : ""} /></label>
      <label className="field">{t("Elevation datum")}<input name="datum" required maxLength={2000} defaultValue={isMock ? "SYNTHETIC-FIXTURE" : ""} /></label>
      <button className="button outline" disabled={busy}>{isMock ? t("Start mock job") : t("Request calculation")}</button>
    </form>
    {error ? <p role="alert">{t(error)}</p> : null}
    {create.isPending ? <p role="status">{t("Submitting request…")}</p> : null}
    {create.error ? <p role="alert">{t(create.error.message)}</p> : null}
    {jobId && job.isPending ? <p role="status">{t("Waiting for job status…")}</p> : null}
    {job.error ? <div role="alert"><p>{t(job.error.message)}</p><button className="button outline" onClick={() => void job.refetch()}>{t("Retry job status")}</button></div> : null}
    {job.data ? <div className="job-status" role="status"><p>{({ queued: t("Queued — waiting for a worker"), running: t("Running — computing observations"), done: t("Completed"), failed: t("Failed") })[job.data.status]}{isMock ? t(" · simulated") : ""}</p><progress aria-label={t("Job progress")} max="100" value={job.data.progressPct} /> <span>{job.data.progressPct}%</span>
      {job.data.status === "failed" ? <p role="alert">{t(apiError(job.data.problem, job.data.problem.status).message)}</p> : job.data.status === "done" ? <button className="button primary" onClick={() => { if (job.data?.status === "done" && create.variables) onResult(job.data.result, create.variables, job.data.jobId); }}>{isMock ? t("Open synthetic results") : t("Open job results")}</button> : null}
    </div> : null}
  </details>;
}
