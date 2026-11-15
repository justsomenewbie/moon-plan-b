"use client";

import { useLanguage } from "./language";

// Explains marker brightness: a gradient bar from 0% to 100% sunlight, and which period the values cover.
export default function SunlightLegend({ period, missing = false }: { period: "period" | "average"; missing?: boolean }) {
  const { t } = useLanguage();
  return <p className="sunlight-legend">
    <span>{t(period === "period" ? "Time with the Sun visible (% of selected period)" : "Time with the Sun visible (% of 2026–2030)")}</span>
    <span>0%</span><i aria-hidden="true" /><span>100%</span>
    {missing && <span className="sunlight-legend-missing"><b aria-hidden="true" />{t("no data")}</span>}
  </p>;
}
