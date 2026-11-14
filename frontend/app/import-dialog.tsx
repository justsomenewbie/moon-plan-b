import type { Ref } from "react";
import type { WindowRequest } from "../lib/api/client";
import { terrainSiteIds, type TerrainTarget } from "../lib/terrain-target";
import { useLanguage } from "./language";

export type ImportGuide =
  | { version: string; exampleMatches: boolean }
  | { target: TerrainTarget; request: WindowRequest; site: string | null; at: string | null }
  | { invalid: true };

export default function ImportDialog({ ref, guide, onImport }: { ref: Ref<HTMLDialogElement>; guide: ImportGuide | null; onImport: (file: File) => void }) {
  const { t } = useLanguage();
  return <dialog ref={ref} id="import-dialog" className="import-dialog" aria-labelledby="import-title">
    <h2 id="import-title" tabIndex={-1} autoFocus>{t("Import a comparison dataset")}</h2>
    <p>{t("Choose one JSON file (.json), up to 5 MiB. Your browser reads the file locally.")}</p>
    {guide && "target" in guide && <div className="wrap-anywhere">
      <p>{t("Choose the terrain JSON file that matches these settings from the shared link.")}</p>
      <ul>
        <li>{t("Model run")} · <code>{guide.target.run_id}</code></li>
        <li>{t("Sites in order")} · <code>{terrainSiteIds(guide.target).split(",").join(", ")}</code></li>
        <li>{t("UTC window: {from} up to but excluding {to}", { from: guide.request.from, to: guide.request.to })}</li>
        <li>{t("Requested sampling step: {seconds} s", { seconds: guide.request.resolutionSeconds })}</li>
        {guide.site && <li>{t("Observation site")} · <code>{guide.site}</code></li>}
        {guide.at && <li>{t("Selected UTC sample")} · <code>{guide.at}</code></li>}
      </ul>
    </div>}
    {guide && "version" in guide && <p className="wrap-anywhere">{t("Choose the scenario JSON file with datasetId {version}. It must contain the scenarios and any UTC sample in this link.", { version: guide.version })}</p>}
    {guide && "invalid" in guide && <p>{t("This comparison link has missing or conflicting settings. Ask the sender for a new link.")}</p>}
    {!guide &&
      <ol>
        <li>{t("Have a Moon Plan B export? Select “Choose JSON file” and open it from your device.")}</li>
        <li>{t("The comparison opens when the file is ready. To practise first, download the example below and choose that file.")}</li>
      </ol>
    }
    {(!guide || ("version" in guide && guide.exampleMatches)) &&
      <a href="/data/demo.json" download="moon-plan-b-example.json">{t("Download an example JSON (synthetic data)")}</a>
    }
    <details>
      <summary>{t("Which file formats can I use?")}</summary>
      <ul>
        <li><strong>{t("Scenario dataset")}</strong> · <code>"schemaVersion": "frontend-draft-2"</code><br />{t("Contains sites, scenarios, UTC observation samples and source metadata.")}</li>
        <li><strong>{t("Terrain dataset")}</strong> · <code>"schema_version": "lunarnav-dataset-1"</code><br />{t("Use a terrain-model export with its run, evaluated time range, sites and visibility results.")}</li>
      </ul>
    </details>
    <div className="import-actions">
      <form method="dialog"><button className="button outline">{t("Cancel")}</button></form>
      <label className="button primary import-picker">{t("Choose JSON file")}
        <input type="file" accept=".json,application/json" aria-label={t("Import JSON dataset")} onChange={event => {
          const file = event.currentTarget.files?.[0];
          if (!file) return;
          event.currentTarget.value = "";
          event.currentTarget.closest("dialog")?.close();
          onImport(file);
        }} />
      </label>
    </div>
  </dialog>;
}
