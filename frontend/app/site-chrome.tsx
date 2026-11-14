"use client";
import { LanguageControl, useLanguage } from "./language";
import ThemeControl from "./theme-control";

export function SkyBackground() {
  return <>
    <div className="sky-clouds" aria-hidden="true">{[0, 1, 2, 3].map(i => <span key={i} />)}</div>
    <div className="night-stars" aria-hidden="true">{[0, 1, 2, 3].map(i => <i key={i} />)}</div>
  </>;
}

export function SiteHeader({ comparisonHref, showSources = false }: {
  comparisonHref?: string;
  showSources?: boolean;
}) {
  const { t } = useLanguage();
  return <header className="app-header"><a className="brand" href="/">Moon Plan B</a>
      <nav aria-label={t("Main")}>
        <a href={comparisonHref ?? "/compare"} className={comparisonHref ? "active-link" : undefined} aria-current={comparisonHref ? "page" : undefined}>{t("Compare")}</a>
        <a href="#resources">{t("Lunar resources")}</a>
        {showSources && <a href="#sources">{t("Sources & method")}</a>}
        <LanguageControl />
        <ThemeControl />
      </nav>
    </header>;
}

export function LunarResources() {
  const { t } = useLanguage();
  return <section id="resources" className="reference-resources" aria-labelledby="resources-heading"><p className="eyebrow">{t("Beyond the comparison")}</p><h2 id="resources-heading">{t("Explore the Moon through its sources.")}</h2><p className="muted">{t("Reference material for learning and cross-checks. These links do not supply the synthetic comparison values.")}</p><div className="resource-links">
      <a href="https://svs.gsfc.nasa.gov/5001/" target="_blank" rel="noreferrer"><strong>{t("The Moon, frame by frame ↗")}</strong><span>{t("See the source and credits for the LRO photographic mosaic.")}</span></a>
      <a href="https://ssd.jpl.nasa.gov/horizons/manual.html#observer-table" target="_blank" rel="noreferrer"><strong>{t("Understand the observations ↗")}</strong><span>{t("Read the JPL Horizons observer-table documentation and coordinate conventions.")}</span></a>
      <a href="https://trek.nasa.gov/moon/" target="_blank" rel="noreferrer"><strong>{t("Explore lunar terrain ↗")}</strong><span>{t("Open NASA Moon Trek in a separate tab to explore its lunar map.")}</span></a>
    </div></section>;
}

export function SiteFooter() {
  const { t } = useLanguage();
  return <footer className="app-footer"><p>{t("Visibility alone does not measure solar power or radio signal strength.")}</p><p>{t("Frontend draft · AI-assisted implementation ·")}{" "}<a href="https://github.com/justsomenewbie/moon-plan-b" target="_blank" rel="noreferrer">{t("Project repository")}</a> · <a href="https://github.com/justsomenewbie/moon-plan-b/issues" target="_blank" rel="noreferrer">{t("Project feedback")}</a></p>
      <div className="sky-appearance"><a className="night-credit" href="https://svs.gsfc.nasa.gov/4851/" target="_blank" rel="noreferrer">{t("Star map")} · NASA/Goddard SVS · ESA/Gaia/DPAC</a>
        <label><input type="checkbox" id="pause-sky-drift" />{t("Pause sky motion")}</label>
      </div>
    </footer>;
}
