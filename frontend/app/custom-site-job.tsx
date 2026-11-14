import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError } from "../lib/api/client";
import type { WindowRequest } from "../lib/api/client";
import type { Message } from "../lib/i18n";
import { createCustomSite, getCustomSiteCapability, getCustomSiteJob } from "../lib/api/custom-site";
import { useLanguage } from "./language";

type Props = {
  readRequest: () => WindowRequest;
  onResult: (request: WindowRequest, ref: { run_id: string; site_id: string }) => void;
};
const labels = {
  queued: "Queued — waiting for a worker", running: "Running — computing observations",
  succeeded: "Completed", failed: "Failed", cancelled: "Cancelled",
};

export default function CustomSiteJob({ readRequest, onResult }: Props) {
  const { t } = useLanguage();
  const [opened, setOpened] = useState(false);
  const [formError, setFormError] = useState<Message>("");
  const submitting = useRef(false);
  const capability = useQuery({ queryKey: ["custom-site-capability"], queryFn: ({ signal }) => getCustomSiteCapability(signal), enabled: opened });
  const create = useMutation({ mutationFn: createCustomSite, retry: false });
  const accepted = create.data;
  const status = useQuery({
    queryKey: ["custom-site-status", accepted?.job_id, accepted?.site_id, create.submittedAt], enabled: !!accepted,
    queryFn: ({ signal }) => getCustomSiteJob(accepted!.job_id, accepted!.site_id, signal, create.variables),
    refetchInterval: query => {
      const state = query.state.data?.status;
      return query.state.error || (state !== "queued" && state !== "running") ? false : 1500;
    },
    staleTime: 0,
  });
  const job = status.data;
  const missing = status.error instanceof ApiError && status.error.status === 404;
  const busy = create.isPending || !!accepted && !missing && (!job || job.status === "queued" || job.status === "running");
  const canSubmit = !!capability.data?.available && !capability.isError && !busy;
  const receiptUncertain = create.error instanceof ApiError && (create.error.status === 0 || create.error.status >= 500);
  function submit(input: Parameters<typeof createCustomSite>[0]) {
    if (!canSubmit || submitting.current) return;
    setFormError("");
    submitting.current = true;
    create.mutate(input, { onSettled: () => { submitting.current = false; } });
  }

  return <details className="request-panel">
    <summary onClick={() => setOpened(true)}>{t("Request a custom lunar location")}</summary>
    <p className="muted">{t("Use the UTC range above. The backend calculates hourly positions with SPICE and a PGDA terrain horizon using ray marching.")}</p>
    {capability.isPending && <p role="status">{t("Checking calculation availability…")}</p>}
    {capability.error && <div role="alert"><p>{t(capability.error.message)}</p><button type="button" className="button outline" onClick={() => void capability.refetch()}>{t("Check availability again")}</button></div>}
    {capability.data && !capability.data.available && <div role="status"><p>{t("Custom-site calculations are unavailable.")} {capability.data.reason}</p><button type="button" className="button outline" onClick={() => void capability.refetch()}>{t("Check availability again")}</button></div>}
    <form className="request-fields" onSubmit={event => {
      event.preventDefault();
      if (!canSubmit || submitting.current || !capability.data) return;
      const form = new FormData(event.currentTarget);
      try {
        const request = readRequest();
        if (Date.parse(request.to) - Date.parse(request.from) > capability.data.maxRangeDays * 86400000) {
          setFormError({ text: "This server accepts at most {days} days per custom-site request.", values: { days: capability.data.maxRangeDays } });
          return;
        }
        submit({ lat_deg: Number(form.get("latitude")), lon_deg: Number(form.get("longitude")), observer_height_m: Number(form.get("height")), start: request.from, end: request.to });
      } catch (error) { setFormError(error instanceof Error ? error.message : "Invalid request."); }
    }}>
      <label className="field">{t("Planetocentric latitude · degrees")}<input name="latitude" type="number" step="any" min="-90" max="90" required /></label>
      <label className="field">{t("East longitude · degrees")}<input name="longitude" type="number" step="any" min="-360" max="360" required /></label>
      <label className="field">{t("Observer height above surface · m")}<input name="height" type="number" step="any" min="0" max={capability.data?.maxObserverHeightM ?? 100} defaultValue="2" required /></label>
      <button className="button outline" disabled={!canSubmit}>{t("Request calculation")}</button>
    </form>
    {formError && <p role="alert">{t(formError)}</p>}
    {create.isPending && <p role="status">{t("Submitting request…")}</p>}
    {create.error && <div role="alert"><p>{t(create.error.message)}</p>
      {receiptUncertain && create.variables && <><p>{t("The server may already have accepted this request.")}</p>
        <button type="button" className="button outline" disabled={!canSubmit} onClick={() => create.variables && submit(create.variables)}>{t("Retry the same request")}</button></>}
    </div>}
    {accepted && create.variables && <div className="job-status">
      <p><code>{accepted.job_id}</code> · {create.variables.start} → {create.variables.end}</p>
      {accepted.cached && <p>{t("The backend reused a matching job.")}</p>}
      <p role="status">{t(labels[job?.status ?? accepted.status])}</p>
      {job?.status === "running" && <p><progress aria-label={t("Job progress")} max={100} value={job.progress.pct ?? undefined} /> {job.progress.pct === null ? t("Progress percentage unavailable.") : `${job.progress.pct}%`}</p>}
      {status.error && <div role="alert"><p>{t(status.error.message)}</p><button type="button" className="button outline" disabled={status.isFetching} onClick={() => void status.refetch()}>{t("Retry job status")}</button></div>}
      {job?.status === "failed" && job.error && <p role="alert">{job.error.code} · {job.error.message}</p>}
      {job?.status === "succeeded" && job.result && !status.error && <button type="button" className="button primary" onClick={() => onResult({ from: create.variables!.start, to: create.variables!.end, resolutionSeconds: 3600 }, job.result!)}>{t("Open job results")}</button>}
    </div>}
  </details>;
}
