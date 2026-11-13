// Synthetic API behavior only. No Horizons request or coordinate computation occurs here.
import { http, HttpResponse } from "msw/http";
import fixture from "../../public/data/demo.json" with { type: "json" };
import contract from "../../public/api/v1/openapi.json" with { type: "json" };
import { validateJobRequest, validateWindow } from "./client.ts";
import type { JobRequest, WindowRequest } from "./client.ts";
const jobs = new Map<string, { started: number; request: JobRequest }>();
const problem = (status: number, detail: string) => HttpResponse.json({ type: "about:blank", title: "Draft API request failed", status, detail }, { status, headers: { "Content-Type": "application/problem+json" } });
const bounded = (request: WindowRequest) => ({ ...fixture, scenarios: fixture.scenarios.filter((s) => Date.parse(s.startUtc) >= Date.parse(request.from) && Date.parse(s.endUtc) <= Date.parse(request.to)) });
export const handlers = [
  http.get("*/api/v1/openapi.json", () => HttpResponse.json(contract)),
  http.get("*/api/v1/dataset", ({ request }) => {
    const params = new URL(request.url).searchParams;
    try {
      const range = validateWindow({ from: params.get("from") ?? "", to: params.get("to") ?? "", resolutionSeconds: Number(params.get("resolutionSeconds")) });
      return HttpResponse.json(bounded(range));
    } catch (error) { return problem(422, error instanceof Error ? error.message : "Invalid range."); }
  }),
  http.post("*/api/v1/jobs", async ({ request }) => {
    try {
      const body = validateJobRequest(await request.json() as JobRequest);
      const jobId = `mock-${crypto.randomUUID()}`;
      if (jobs.size >= 20) jobs.delete(jobs.keys().next().value!);
      jobs.set(jobId, { started: Date.now(), request: body });
      return HttpResponse.json({ jobId }, { status: 202 });
    } catch (error) { return problem(422, error instanceof Error ? error.message : "Invalid job request."); }
  }),
  http.get("*/api/v1/jobs/:id", ({ params }) => {
    const jobId = String(params.id), job = jobs.get(jobId);
    if (!job) return problem(404, "This mock job is unavailable. Mock jobs disappear on reload.");
    const elapsed = Date.now() - job.started;
    const status = elapsed < 1500 ? "queued" : elapsed < 4500 ? "running" : "done";
    return HttpResponse.json({ jobId, status, progressPct: status === "queued" ? 0 : status === "done" ? 100 : 50, result: status === "done" ? bounded(job.request) : null, problem: null });
  }),
];
