"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { compareSites, type SiteComparison } from "../lib/api/compare-sites";
import { pairGuideContext, type GuideContext } from "../lib/api/guide-chat";
import { getTerrainDateSites } from "../lib/api/terrain-dates";
import { writeTerrainTarget } from "../lib/terrain-target";
import type { TerrainSummary } from "../lib/api/terrain-summary";
import { useLanguage } from "./language";
import { SiteSourceLinks, TimeRange } from "./terrain-site-result";
import PairCatalogRanking from "./catalog-ranking";

const weightLabels = [
  ["pct_sun", "Sun visible"], ["pct_earth", "Earth visible"],
  ["pct_both", "Both visible"], ["pct_sun_no_earth", "Sun without Earth visibility"],
] as const;

export type DisplayedPair = { terrain: TerrainSummary; context: GuideContext };

export default function TerrainPair({ result, onDisplayedPair, replay, resolutionSeconds }: {
  result: TerrainSummary; replay: boolean; resolutionSeconds: number; onDisplayedPair: (pair: DisplayedPair | null) => void;
}) {
  const { t } = useLanguage();
  const runId = result.run.run_id;
  const { start, end } = result.range;
  const [opened, setOpened] = useState(replay);
  const catalog = useQuery({
    queryKey: ["terrain-date-sites", runId],
    queryFn: ({ signal }) => getTerrainDateSites(runId, signal),
    enabled: opened,
  });
  const sites = catalog.data ?? result.sites;
  const [choice, setChoice] = useState<[string, string]>([result.sites[0]?.id ?? "", result.sites[1]?.id ?? ""]);
  const [comparison, setComparison] = useState<SiteComparison>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const canSubmit = choice[0] !== choice[1] && choice.every(id => sites.some(site => site.id === id));
  const completePair = comparison?.ranking.every(row => comparison.coverageBySite[row.site_id] === "complete");

  // With incomplete coverage, keep the user's order so placement cannot imply a scientific ranking.
  const rows = useMemo(() => completePair ? comparison?.ranking : comparison?.ranking.toSorted(
    (a, b) => choice.indexOf(a.site_id) - choice.indexOf(b.site_id)), [choice, comparison, completePair]);

  useLayoutEffect(() => {
    if (!opened || !comparison || !rows) return;
    onDisplayedPair({ terrain: result, context: pairGuideContext(comparison, rows) });
    return () => onDisplayedPair(null);
  }, [opened, comparison, rows, result, onDisplayedPair]);

  function choose(index: number, value: string) {
    active.current?.abort();
    setPending(false);
    setComparison(undefined);
    setError("");
    setChoice(index === 0 ? [value, choice[1]] : [choice[0], value]);
  }

  async function compare() {
    if (!canSubmit || pending) return;
    const controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    setPending(true);
    setComparison(undefined);
    setError("");
    try {
      const next = await compareSites({ runId, siteIds: choice, from: start, to: end }, controller.signal);
      if (!controller.signal.aborted) setComparison(next);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The request could not be completed. Retry or check the connection.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  const reopen = useEffectEvent(() => { void compare(); });
  useEffect(() => { if (replay) reopen(); }, [replay]);

  function pairHref() {
    const params = new URLSearchParams({ from: start, to: end, resolutionSeconds: String(resolutionSeconds) });
    writeTerrainTarget(params, { run_id: runId, site_ids: choice.join(",") });
    return "/compare?" + params + "#terrain-pair";
  }

  return <details id="terrain-pair" open={replay || undefined} className="details-section" onToggle={event => {
    setOpened(event.currentTarget.open);
    if (!event.currentTarget.open) { active.current?.abort(); setPending(false); }
  }}>
    <summary>{t("Rank two sites for this UTC range")}</summary>
    <p>{t("Comparison window (UTC, end exclusive)")} · <TimeRange start={start} end={end} /></p>
    <form className="request-fields my-4 print:hidden" onSubmit={event => { event.preventDefault(); void compare(); }}>
      {choice.map((id, index) => <label key={index} className="field">
        {t(index === 0 ? "First site in pair" : "Second site in pair")}
        <select name={index === 0 ? "pairFirstSite" : "pairSecondSite"} required
          value={sites.some(site => site.id === id) ? id : ""} onChange={event => choose(index, event.target.value)}>
          <option value="">{t("Choose a site")}</option>
          {sites.map(site => <option key={site.id} value={site.id} disabled={site.id === choice[1 - index]}>{site.name}</option>)}
        </select>
      </label>)}
      <button className="button outline" type="submit" disabled={!canSubmit || pending}>
        {t(error ? "Retry pair comparison" : "Compare this pair")}
      </button>
    </form>
    {catalog.isFetching && <p role="status">{t("Loading sites for this run…")}</p>}
    {catalog.isError && <p role="status">{t("The full site list is unavailable. Only sites in the current dataset are available.")}{" "}
      <button className="button outline" type="button" onClick={() => void catalog.refetch()}>{t("Retry site list")}</button>
    </p>}
    {!catalog.isFetching && sites.length < 2 && <p>{t("Two distinct sites from this run are needed for a pair comparison.")}</p>}
    {pending && <p role="status">{t("Comparing the selected sites…")}</p>}
    {error && <p role="alert">{t(error)}</p>}
    {comparison && <section aria-label={t("Pair comparison results")}>
      <p>{t("Evaluated UTC range")} · <TimeRange start={comparison.range.start} end={comparison.range.end} /><br />
        {t("Boundary precision")} ±{comparison.precision_h} h</p>
      <p className="muted text-sm">{t("Score weights")} · {weightLabels
        .filter(([key]) => comparison.weights[key] !== undefined)
        .map(([key, label]) => t(label) + " " + comparison.weights[key]).join(" · ")}</p>
      {!completePair && <p className="data-notice">{t("Coverage is incomplete for this pair. Its scores and ranking are unavailable for the full window.")}</p>}
      <div className="week-sites">{rows?.map(row => {
        const coverage = comparison.coverageBySite[row.site_id];
        const warnings = comparison.sites[row.site_id].warnings;
        return <article key={row.site_id} className="min-w-0">
          <h3>{row.name}</h3>
          <p>{t("Coverage")} · {t(coverage)}</p>
          {completePair && <p><strong>{t("Rank {rank} of 2", { rank: row.rank })}</strong> · {t("Weighted score")} {row.score}</p>}
          {coverage === "complete" ? <dl className="metadata">
            <div><dt>{t("Sun visible")}</dt><dd>{row.pct_sun}%</dd></div>
            <div><dt>{t("Earth visible")}</dt><dd>{row.pct_earth}%</dd></div>
            <div><dt>{t("Both visible")}</dt><dd>{row.pct_both}%</dd></div>
          </dl> : <p>{t("Visibility percentages are unknown for the full window.")}</p>}
          {warnings.length > 0 && <><h4>{t("Model warnings")}</h4>
            <ul className="list-disc pl-5">{warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></>}
          <SiteSourceLinks siteId={row.site_id} runId={comparison.run_id} range={comparison.range} />
        </article>;
      })}</div>
      <a className="print:hidden" href={pairHref()} target="_blank" rel="noreferrer">{t("Open this ranked pair in a new tab")}</a>
      {opened && completePair && <PairCatalogRanking comparison={comparison} catalogSites={catalog.data} />}
    </section>}
  </details>;
}
