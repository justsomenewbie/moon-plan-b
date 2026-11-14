import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TerrainSummary } from "../lib/api/terrain-summary";
import { getRunFiles } from "../lib/api/run-files";
import { useLanguage } from "./language";

export function ComparisonDownload({ result }: { result: TerrainSummary }) {
  const { t } = useLanguage();
  const file = result.exportFile;
  const [link, setLink] = useState<{ file: Blob; url: string }>();
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setLink({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  if (!file || link?.file !== file) return null;
  return <a className="button outline" href={link.url} download={result.dataset_id + ".json"}>
    {t("Download this comparison (JSON)")}</a>;
}

export function RunDownloads({ run }: { run: TerrainSummary["run"] }) {
  const { t } = useLanguage();
  const [opened, setOpened] = useState(false);
  const [selected, setSelected] = useState("");
  const files = useQuery({ queryKey: ["source-files", run.run_id, run.manifest_sha256], enabled: opened,
    retry: false, queryFn: ({ signal }) => getRunFiles(run, signal) });
  const file = files.data?.find(f => f.path === selected) ?? files.data?.[0];
  const geoCatalog = new URLSearchParams({ run_id: run.run_id, format: "geojson" });
  return <div className="print:hidden mt-3 space-y-2">
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      <a href={"/api/v1/sites?" + geoCatalog} target="_blank" rel="noreferrer">{t("Open site catalog (GeoJSON)")}</a>
      <a href={"/api/v1/export/summary.csv?" + new URLSearchParams({ run_id: run.run_id })} target="_blank" rel="noreferrer">{t("Download full-run summary (CSV)")}</a>
    </div>
    <details onToggle={e => setOpened(e.currentTarget.open)}>
      <summary>{t("Original files from this run")}</summary>
      {files.isFetching ? <p role="status">{t("Loading source files…")}</p> :
        files.isError ? <div role="alert"><p>{t(files.error.message)}</p><button className="button outline" type="button" onClick={() => void files.refetch()}>{t("Retry")}</button></div> :
        file ? <div className="space-y-1 mt-2">
          <label className="block">{t("Choose a source file")} <select className="max-w-full" value={file.path} onChange={e => setSelected(e.target.value)}>
            {files.data?.map(f => <option key={f.path} value={f.path}>{f.path}</option>)}</select></label>
          <a href={file.href} target="_blank" rel="noreferrer">{t("Download selected source file")}</a>
          <code className="hash">SHA-256 {file.sha256}</code>
        </div> : opened && files.data && <p>{t("The run lists no downloadable source files.")}</p>}
    </details>
  </div>;
}
