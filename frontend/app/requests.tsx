"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiError, createJob, getJob, isMock, jobPollInterval, windowFromInputs } from "../lib/api/client";
import type { WindowRequest } from "../lib/api/client";
import type { Dataset } from "../lib/dataset";

type ResultHandler = (data: Dataset, request: WindowRequest, jobId: string) => void;
const windowInputs = (request: WindowRequest) => ({ from: request.from.slice(0, -1), to: request.to.slice(0, -1), resolution: String(request.resolutionSeconds) });

export function ApiControls({ request, loading, onLoad, onResult }: { request: WindowRequest; loading: boolean; onLoad: (request: WindowRequest) => void; onResult: ResultHandler }) {
  const [error, setError] = useState("");
  const [inputs, setInputs] = useState(() => windowInputs(request));
  const previousRequest = useRef(request);
  // A response may update defaults, but must not overwrite a newer draft.
  useEffect(() => {
    const previous = previousRequest.current;
    setInputs((current) => {
      try {
        const draft = windowFromInputs(current.from, current.to, current.resolution);
        if (Date.parse(draft.from) === Date.parse(previous.from) && Date.parse(draft.to) === Date.parse(previous.to) && draft.resolutionSeconds === previous.resolutionSeconds) return windowInputs(request);
      } catch { /* An incomplete draft stays editable. */ }
      return current;
    });
    previousRequest.current = request;
  }, [request]);
  const readRequest = () => windowFromInputs(inputs.from, inputs.to, inputs.resolution);
  return <><details className="request-panel"><summary>Request observation windows</summary><p className="muted">UTC throughout. Both actions use these editable values. The proposed API limits a request to 31 days and 10,000 samples per series. Actual cadence is reported with each result.</p>
    <form className="request-fields" onSubmit={(event) => {
      event.preventDefault();
      try { const next = readRequest(); setError(""); onLoad(next); } catch (e) { setError(e instanceof Error ? e.message : "Invalid request."); }
    }}>
      <label className="field">From · UTC<input name="from" type="datetime-local" step="0.001" required value={inputs.from} onChange={(e) => setInputs({ ...inputs, from: e.target.value })} /></label>
      <label className="field">To · UTC<input name="to" type="datetime-local" step="0.001" required value={inputs.to} onChange={(e) => setInputs({ ...inputs, to: e.target.value })} /></label>
      <label className="field">Desired step · seconds<input name="resolution" type="number" min="60" max="86400" step="1" required value={inputs.resolution} onChange={(e) => setInputs({ ...inputs, resolution: e.target.value })} /></label>
      <button className="button outline" disabled={loading}>Load windows</button>
    </form>{error ? <p role="alert">{error}</p> : null}
  </details><JobForm readRequest={readRequest} onResult={onResult} /></>;
}

function JobForm({ readRequest, onResult }: { readRequest: () => WindowRequest; onResult: ResultHandler }) {
  const [jobId, setJobId] = useState("");
  const [error, setError] = useState("");
  const create = useMutation({ mutationFn: createJob, onSuccess: (job) => setJobId(job.jobId) });
  const job = useQuery({ queryKey: ["job", jobId, create.variables], queryFn: ({ signal }) => getJob(jobId, create.variables!, signal), enabled: Boolean(jobId && create.variables), refetchInterval: (query) => query.state.error ? false : jobPollInterval(query.state.data), refetchOnWindowFocus: false });
  const busy = create.isPending || Boolean(jobId) && !job.error && job.data?.status !== "done" && job.data?.status !== "failed";
  return <details className="request-panel"><summary>{isMock ? "Try a synthetic job" : "Request a custom lunar location"}</summary>
    <p className="muted">{isMock ? "This simulates queued, running and completed responses. It returns the fictional fixture; entered coordinates are not computed." : "The backend computes the observations. Confirm the coordinate frame and elevation datum with the data producer."} Uses the request range above.</p>
    <form className="request-fields" onSubmit={(event) => {
      event.preventDefault(); const fields = new FormData(event.currentTarget);
      try {
        const request = readRequest(); setError(""); setJobId("");
        create.mutate({ ...request, location: { latitudeDeg: Number(fields.get("latitude")), longitudeEastDeg: Number(fields.get("longitude")), elevationKm: Number(fields.get("elevation")), frame: String(fields.get("frame")), elevationDatum: String(fields.get("datum")) } });
      } catch (e) { setError(e instanceof Error ? e.message : "Invalid request range above."); }
    }}>
      <label className="field">Latitude · degrees<input name="latitude" type="number" min="-90" max="90" step="any" required defaultValue="0" /></label>
      <label className="field">East longitude · degrees<input name="longitude" type="number" min="-180" max="180" step="any" required defaultValue="0" /></label>
      <label className="field">Elevation · km<input name="elevation" type="number" min="-100" max="100" step="any" required defaultValue="0" /></label>
      <label className="field">Coordinate frame<input name="frame" required maxLength={2000} defaultValue={isMock ? "SYNTHETIC-FIXTURE" : ""} /></label>
      <label className="field">Elevation datum<input name="datum" required maxLength={2000} defaultValue={isMock ? "SYNTHETIC-FIXTURE" : ""} /></label>
      <button className="button outline" disabled={busy}>{isMock ? "Start mock job" : "Request calculation"}</button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    {create.isPending ? <p role="status">Submitting request…</p> : null}
    {create.error ? <p role="alert">{create.error.message}</p> : null}
    {jobId && job.isPending ? <p role="status">Waiting for job status…</p> : null}
    {job.error ? <div role="alert"><p>{job.error.message}</p><button className="button outline" onClick={() => void job.refetch()}>Retry job status</button></div> : null}
    {job.data ? <div className="job-status" role="status"><p>{({ queued: "Queued — waiting for a worker", running: "Running — computing observations", done: "Completed", failed: "Failed" })[job.data.status]}{isMock ? " · simulated" : ""}</p><progress aria-label="Job progress" max="100" value={job.data.progressPct} /> <span>{job.data.progressPct}%</span>
      {job.data.status === "failed" ? <p role="alert">{apiError(job.data.problem, job.data.problem.status).message}</p> : job.data.status === "done" ? <button className="button primary" onClick={() => { if (job.data?.status === "done" && create.variables) onResult(job.data.result, create.variables, job.data.jobId); }}>Open {isMock ? "synthetic" : "job"} results</button> : null}
    </div> : null}
  </details>;
}
