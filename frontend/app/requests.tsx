"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiError, createJob, getJob, isMock, jobPollInterval, validateWindow } from "../lib/api/client";
import type { WindowRequest } from "../lib/api/client";
import type { Dataset } from "../lib/dataset";

export function ApiControls({ request, loading, onLoad }: { request: WindowRequest; loading: boolean; onLoad: (request: WindowRequest) => void }) {
  const [error, setError] = useState("");
  return <details className="request-panel"><summary>Request observation windows</summary><p className="muted">UTC throughout. The proposed API limits a request to 31 days and 10,000 samples per series. Actual cadence is reported with each result.</p>
    <form key={JSON.stringify(request)} className="request-fields" onSubmit={(event) => {
      event.preventDefault(); const fields = new FormData(event.currentTarget);
      try { const next = validateWindow({ from: `${fields.get("from")}:00Z`, to: `${fields.get("to")}:00Z`, resolutionSeconds: Number(fields.get("resolution")) }); setError(""); onLoad(next); } catch (e) { setError(e instanceof Error ? e.message : "Invalid request."); }
    }}>
      <label className="field">From · UTC<input name="from" type="datetime-local" required defaultValue={request.from.slice(0, 16)} /></label>
      <label className="field">To · UTC<input name="to" type="datetime-local" required defaultValue={request.to.slice(0, 16)} /></label>
      <label className="field">Desired step · seconds<input name="resolution" type="number" min="60" max="86400" step="1" required defaultValue={request.resolutionSeconds} /></label>
      <button className="button outline" disabled={loading}>Load windows</button>
    </form>{error ? <p role="alert">{error}</p> : null}
  </details>;
}

export function JobForm({ request, onResult }: { request: WindowRequest; onResult: (data: Dataset, request: WindowRequest, jobId: string) => void }) {
  const [jobId, setJobId] = useState("");
  const create = useMutation({ mutationFn: createJob, onSuccess: (job) => setJobId(job.jobId) });
  const job = useQuery({ queryKey: ["job", jobId], queryFn: ({ signal }) => getJob(jobId, signal), enabled: Boolean(jobId), refetchInterval: (query) => query.state.error ? false : jobPollInterval(query.state.data), refetchOnWindowFocus: false });
  const busy = create.isPending || Boolean(jobId) && !job.error && job.data?.status !== "done" && job.data?.status !== "failed";
  return <details className="request-panel"><summary>{isMock ? "Try a synthetic job" : "Request a custom lunar location"}</summary>
    <p className="muted">{isMock ? "This simulates queued, running and completed responses. It returns the fictional fixture; entered coordinates are not computed." : "The backend computes the observations. Confirm the coordinate frame and elevation datum with the data producer."} Uses the request range above.</p>
    <form className="request-fields" onSubmit={(event) => {
      event.preventDefault(); const fields = new FormData(event.currentTarget); setJobId("");
      create.mutate({ ...request, location: { latitudeDeg: Number(fields.get("latitude")), longitudeEastDeg: Number(fields.get("longitude")), elevationKm: Number(fields.get("elevation")), frame: String(fields.get("frame")), elevationDatum: String(fields.get("datum")) } });
    }}>
      <label className="field">Latitude · degrees<input name="latitude" type="number" min="-90" max="90" step="any" required defaultValue="0" /></label>
      <label className="field">East longitude · degrees<input name="longitude" type="number" min="-180" max="180" step="any" required defaultValue="0" /></label>
      <label className="field">Elevation · km<input name="elevation" type="number" min="-100" max="100" step="any" required defaultValue="0" /></label>
      <label className="field">Coordinate frame<input name="frame" required maxLength={2000} defaultValue={isMock ? "SYNTHETIC-FIXTURE" : ""} /></label>
      <label className="field">Elevation datum<input name="datum" required maxLength={2000} defaultValue={isMock ? "SYNTHETIC-FIXTURE" : ""} /></label>
      <button className="button outline" disabled={busy}>{isMock ? "Start mock job" : "Request calculation"}</button>
    </form>
    {create.isPending ? <p role="status">Submitting request…</p> : null}
    {create.error ? <p role="alert">{create.error.message}</p> : null}
    {jobId && job.isPending ? <p role="status">Waiting for job status…</p> : null}
    {job.error ? <div role="alert"><p>{job.error.message}</p><button className="button outline" onClick={() => void job.refetch()}>Retry job status</button></div> : null}
    {job.data ? <div className="job-status" role="status"><p>{({ queued: "Queued — waiting for a worker", running: "Running — computing observations", done: "Completed", failed: "Failed" })[job.data.status]}{isMock ? " · simulated" : ""}</p><progress aria-label="Job progress" max="100" value={job.data.progressPct} /> <span>{job.data.progressPct}%</span>
      {job.data.status === "failed" ? <p role="alert">{apiError(job.data.problem, job.data.problem.status).message}</p> : job.data.status === "done" ? <button className="button primary" onClick={() => { if (job.data?.status === "done" && create.variables) onResult(job.data.result, create.variables, job.data.jobId); }}>Open {isMock ? "synthetic" : "job"} results</button> : null}
    </div> : null}
  </details>;
}
