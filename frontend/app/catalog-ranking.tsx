"use client";

import { useEffect, useRef, useState } from "react";
import { getCatalogRanking, type CatalogRanking } from "../lib/api/catalog-ranking";
import type { SiteComparison } from "../lib/api/compare-sites";
import { useLanguage } from "./language";

type Lookup = { status: "closed" | "pending" } | { status: "error"; message: string } | { status: "ready"; result: CatalogRanking };

const actions = {
  closed: "Show catalog ranks",
  pending: "Cancel catalog ranking",
  error: "Retry catalog ranking",
  ready: "Hide catalog ranks",
} as const;

export default function PairCatalogRanking({ comparison, catalogSites }: {
  comparison: SiteComparison; catalogSites?: readonly { id: string }[];
}) {
  const { t } = useLanguage();
  const [lookup, setLookup] = useState<Lookup>({ status: "closed" });
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function toggle() {
    active.current?.abort();
    if (lookup.status === "ready" || lookup.status === "pending") {
      setLookup({ status: "closed" });
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setLookup({ status: "pending" });
    try {
      const result = await getCatalogRanking(comparison, controller.signal, catalogSites);
      if (!controller.signal.aborted) setLookup({ status: "ready", result });
    } catch (error) {
      if (!controller.signal.aborted) setLookup({ status: "error", message: error instanceof Error ? error.message : "The request could not be completed. Retry or check the connection." });
    }
  }

  return <div id="catalog-ranking" className="mt-4">
    <button type="button" className="button outline print:hidden" aria-expanded={lookup.status !== "closed"}
      aria-controls="catalog-ranking-result" onClick={toggle}>{t(actions[lookup.status])}</button>
    <div id="catalog-ranking-result">
      {lookup.status === "pending" && <p role="status">{t("Loading catalog ranks…")}</p>}
      {lookup.status === "error" && <p role="alert">{t(lookup.message)}</p>}
      {lookup.status === "ready" && <section aria-labelledby="catalog-ranking-title" className="mt-3">
        <h3 id="catalog-ranking-title">{t("Catalog ranking for the selected sites")}</h3>
        <p role="status" className="muted text-sm">{t("Ranked across {count} sites using this comparison’s UTC range and score weights.", { count: lookup.result.ranking.length })}</p>
        <ul className="mt-2 space-y-2">
          {comparison.ranking.map(pair => {
            const row = lookup.result.ranking.find(entry => entry.site_id === pair.site_id)!;
            return <li key={row.site_id}><strong>{row.name}</strong><br />
              {t("Pair rank {pair} of 2 · Catalog rank {rank} of {count}", { pair: pair.rank, rank: row.rank, count: lookup.result.ranking.length })}</li>;
          })}
        </ul>
      </section>}
    </div>
  </div>;
}
