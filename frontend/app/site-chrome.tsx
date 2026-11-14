"use client";
import { useRef, useState } from "react";
import { LanguageControl, useLanguage } from "./language";
import ThemeControl from "./theme-control";

export function SkyBackground() {
  return <>
    <div className="sky-clouds" aria-hidden="true">{[0, 1, 2, 3].map(i => <span key={i} />)}</div>
    <div className="night-stars" aria-hidden="true">{[0, 1, 2, 3].map(i => <i key={i} />)}{[0, 1, 2, 3].map(i => <span key={i} />)}</div>
  </>;
}

export function SiteHeader({ comparisonHref, showSources = false }: {
  comparisonHref?: string;
  showSources?: boolean;
}) {
  const { t } = useLanguage();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  return <header className={comparisonHref ? "app-header" : "app-header home-header"}><a className="brand" href="/">Moon Plan B</a>
      {!comparisonHref && <button className="home-menu" ref={menuButton} type="button"
        aria-controls="main-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{t("Menu")}</button>}
      <nav id="main-navigation" aria-label={t("Main")} onKeyDown={event => {
        if (event.key === "Escape" && menuButton.current?.offsetWidth) {
          setMenuOpen(false);
          menuButton.current.focus();
        }
      }}>
        <a href={comparisonHref ?? "/compare"} className={comparisonHref ? "active-link" : undefined} aria-current={comparisonHref ? "page" : undefined}>{t("Compare")}</a>
        {!comparisonHref && <>
          <a href="#about" onClick={() => setMenuOpen(false)}>{t("About the project")}</a>
          <a href="/compare#saved-model-source">{t("Sources & method")}</a>
          <a href="#team" onClick={() => setMenuOpen(false)}>{t("Team members")}</a>
        </>}
        <a href="#resources" onClick={() => setMenuOpen(false)}>{t("Lunar resources")}</a>
        {showSources && <a href="#sources">{t("Sources & method")}</a>}
        <LanguageControl />
        <ThemeControl />
      </nav>
    </header>;
}

export function LunarResources() {
  const { t } = useLanguage();
  return <section id="resources" className="reference-resources" tabIndex={-1} aria-labelledby="resources-heading"><p className="eyebrow">{t("Beyond the comparison")}</p><h2 id="resources-heading">{t("Explore the Moon through its sources.")}</h2><p className="muted">{t("Reference material for learning and cross-checks. These links do not supply the synthetic comparison values.")}</p><div className="resource-links">
      <a href="https://svs.gsfc.nasa.gov/5001/" target="_blank" rel="noreferrer"><strong>{t("The Moon, frame by frame ↗")}</strong><span>{t("See the source and credits for the LRO photographic mosaic.")}</span></a>
      <a href="https://ssd.jpl.nasa.gov/horizons/manual.html#observer-table" target="_blank" rel="noreferrer"><strong>{t("Understand the observations ↗")}</strong><span>{t("Read the JPL Horizons observer-table documentation and coordinate conventions.")}</span></a>
      <a href="https://trek.nasa.gov/moon/" target="_blank" rel="noreferrer"><strong>{t("Explore lunar terrain ↗")}</strong><span>{t("Open NASA Moon Trek in a separate tab to explore its lunar map.")}</span></a>
    </div></section>;
}

export function SiteFooter() {
  const { t } = useLanguage();
  return <footer className="app-footer"><p>{t("Visibility alone does not measure solar power or radio signal strength.")}</p><p>{t("Frontend draft · AI-assisted implementation ·")}{" "}<a href="https://github.com/justsomenewbie/moon-plan-b" target="_blank" rel="noreferrer">{t("Project repository")}</a> · <a href="https://github.com/justsomenewbie/moon-plan-b/issues" target="_blank" rel="noreferrer">{t("Project feedback")}</a></p>
      <div className="footer-directory" id="contact">
        <section><h2>{t("University and school")}</h2>
          <a href="https://sae.uet.vnu.edu.vn/">{t("School of Aerospace Engineering")}</a>
          <a href="https://www.facebook.com/SAE.UET.VNU/">{t("School of Aerospace Engineering on Facebook")}</a>
          <a href="https://uet.vnu.edu.vn/">{t("VNU University of Engineering and Technology")}</a>
        </section>
        <section><h2>{t("Contact the Moon Plan B team")}</h2>
          <a href="mailto:nguyennhuson317@gmail.com">nguyennhuson317@gmail.com</a>
          <a href="tel:+84855008666">+84 855 008 666</a>
        </section>
      </div>
      <div className="sky-appearance"><a className="night-credit" href="https://svs.gsfc.nasa.gov/4851/" target="_blank" rel="noreferrer">{t("Star map")} · NASA/Goddard SVS · ESA/Gaia/DPAC</a>
        <label><input type="checkbox" id="pause-sky-drift" />{t("Pause sky and astronaut motion")}</label>
      </div>
    </footer>;
}
