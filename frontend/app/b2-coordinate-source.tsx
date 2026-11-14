import records from "../public/data/run-b2/sites.json";
import { useLanguage } from "./language";

export default function B2CoordinateSource({ siteId }: { siteId: string }) {
  const { t } = useLanguage();
  const site = records.sites.find(row => row.id === siteId);
  if (!site) return null;
  return <dl className="space-y-2">
    <div><dt>{t("Coordinate note")}</dt><dd>{t(site.note)}</dd></div>
    <div><dt>{t("Coordinate source")}</dt><dd lang="en">{site.source}</dd></div>
  </dl>;
}
