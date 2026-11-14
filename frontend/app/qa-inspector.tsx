import type { Dataset, Scenario } from "../lib/dataset";
import { useLanguage } from "./language";

function hasNorthWrap(scenario: Scenario) {
  return scenario.samples.some((sample, index) => index > 0 && (["sun", "earth"] as const).some(body => {
    if (Date.parse(sample.utc) - Date.parse(scenario.samples[index - 1].utc) > scenario.sampleStepSeconds * 1500) return false;
    const before = scenario.samples[index - 1][body];
    const after = sample[body];
    return before && after && Math.abs(after.azimuthDeg - before.azimuthDeg) > 180;
  }));
}

function hasHorizonCrossing(scenario: Scenario) {
  return scenario.samples.some((sample, index) => index > 0 && (["sun", "earth"] as const).some(body => {
    if (Date.parse(sample.utc) - Date.parse(scenario.samples[index - 1].utc) > scenario.sampleStepSeconds * 1500) return false;
    const before = scenario.samples[index - 1][body]?.elevationDeg;
    const after = sample[body]?.elevationDeg;
    return before !== undefined && after !== undefined && (before === 0 || after === 0 || (before < 0) !== (after < 0));
  }));
}

export default function QaInspector({ data, active, onSelect }: { data: Dataset; active: Scenario; onSelect: (scenario: Scenario) => void }) {
  const { t } = useLanguage();
  const counts = data.scenarios.reduce((result, scenario) => { result[scenario.coverage]++; return result; }, { complete: 0, partial: 0, missing: 0 });
  return <aside className="qa-inspector" aria-labelledby="qa-inspector-title">
    <div><p className="eyebrow">{t("Local test harness")}</p><h2 id="qa-inspector-title">{t("QA & Judge Inspector")}</h2></div>
    <p className="qa-pass" role="status">{t("Contract validation passed before rendering")}</p>
    <dl className="qa-metrics"><div><dt>{t("Dataset")}</dt><dd>{data.datasetId}</dd></div><div><dt>{t("Evidence")}</dt><dd>{data.evidence}</dd></div><div><dt>{t("Schema")}</dt><dd>{data.schemaVersion}</dd></div><div><dt>{t("Coverage")}</dt><dd>{counts.complete} {t("complete")} · {counts.partial} {t("partial")} · {counts.missing} {t("missing")}</dd></div></dl>
    <div className="qa-actions" aria-label={t("Stress scenarios")}>{data.scenarios.map(scenario => <button type="button" className={scenario.id === active.id ? "active" : ""} key={scenario.id} onClick={() => onSelect(scenario)} aria-pressed={scenario.id === active.id}>{scenario.id}<span>{t(scenario.coverage)}{hasHorizonCrossing(scenario) ? ` · ${t("0° crossing")}` : ""}{hasNorthWrap(scenario) ? ` · ${t("north wrap")}` : ""}</span></button>)}</div>
    <p className="muted text-xs">{data.evidence === "synthetic-fixture" ? t("Inspector scenarios are validated synthetic fixtures. They do not become real lunar observations, and this panel does not simulate GPU failure.") : t("Inspector scenarios passed structural validation. This panel does not independently verify scientific validity or simulate GPU failure.")}</p>
  </aside>;
}
