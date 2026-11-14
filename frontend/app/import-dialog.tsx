import type { Ref } from "react";
import { useLanguage } from "./language";

export default function ImportDialog({ ref, onImport }: { ref: Ref<HTMLDialogElement>; onImport: (file: File) => void }) {
  const { t } = useLanguage();
  return <dialog ref={ref} id="import-dialog" className="import-dialog" aria-labelledby="import-title">
    <h2 id="import-title" tabIndex={-1} autoFocus>{t("Import a comparison dataset")}</h2>
    <p>{t("Choose one JSON file (.json), up to 5 MiB. Your browser reads the file locally.")}</p>
    <ol>
      <li>{t("Have a Moon Plan B export? Select “Choose JSON file” and open it from your device.")}</li>
      <li>{t("The comparison opens when the file is ready. To practise first, download the example below and choose that file.")}</li>
    </ol>
    <a href="/data/demo.json" download="moon-plan-b-example.json">{t("Download an example JSON (synthetic data)")}</a>
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
