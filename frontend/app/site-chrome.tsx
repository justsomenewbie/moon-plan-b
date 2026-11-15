"use client";
import { useRef, useState } from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { LanguageControl, useLanguage } from "./language";
import ThemeControl from "./theme-control";

export function SkyBackground() {
  return <>
    <div className="night-stars" aria-hidden="true">{[0, 1, 2, 3].map(i => <i key={i} />)}{[0, 1, 2, 3].map(i => <span key={i} />)}</div>
  </>;
}

const sections = [
  ["/compare", "Compare"], ["/plan", "Plan"], ["/orbit", "Orbit"], ["/data", "Data"], ["/api-docs", "API"],
] as const;

// One header with the same logo, links and controls on every page.
export function SiteHeader(_: {
  comparisonHref?: string;
  showSources?: boolean;
}) {
  const { t } = useLanguage();
  const pathname = usePathname() ?? "";
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  return <header className="app-header" data-menu={menuOpen ? "open" : "closed"} onKeyDown={event => {
      if (event.key === "Escape" && menuOpen && menuButton.current?.offsetWidth) {
        setMenuOpen(false);
        menuButton.current.focus();
      }
    }}>
      {/* The wordmark names the link; the team logo beside it is decorative. */}
      <a className="brand" href="/" aria-current={pathname === "/" ? "page" : undefined}>
        <Image src="/brand/logo-256.png" width={40} height={40} alt="" priority />
        <span>Moon Plan B</span>
      </a>
      <button className="nav-menu" ref={menuButton} type="button"
        aria-controls="main-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{t("Menu")}</button>
      <div className="header-panel" id="main-navigation">
      <nav aria-label={t("Main")}>
        {sections.map(([href, label]) => {
          const active = pathname === href || pathname.startsWith(href + "/") || pathname.startsWith(href + "-");
          return <a key={href} href={href}
            className={active ? "active-link" : undefined} aria-current={active ? "page" : undefined}
            onClick={() => setMenuOpen(false)}>{t(label)}</a>;
        })}
      </nav>
      <div className="header-controls">
        <LanguageControl />
        <ThemeControl />
      </div>
      </div>
    </header>;
}

export function LunarResources() {
  const { t } = useLanguage();
  return <section id="resources" className="reference-resources" tabIndex={-1} aria-labelledby="resources-heading"><p className="eyebrow">{t("Beyond the comparison")}</p><h2 id="resources-heading">{t("Explore the Moon through its sources.")}</h2><p className="muted">{t("Explore the imagery and observation methods. Each result identifies its own data source.")}</p><div className="resource-links">
      <a href="https://svs.gsfc.nasa.gov/5001/" target="_blank" rel="noreferrer"><strong>{t("The Moon, frame by frame ↗")}</strong><span>{t("See the source and credits for the LRO photographic mosaic.")}</span></a>
      <a href="https://ssd.jpl.nasa.gov/horizons/manual.html#observer-table" target="_blank" rel="noreferrer"><strong>{t("Understand the observations ↗")}</strong><span>{t("Read the JPL Horizons observer-table documentation and coordinate conventions.")}</span></a>
      <a href="https://trek.nasa.gov/moon/" target="_blank" rel="noreferrer"><strong>{t("Explore lunar terrain ↗")}</strong><span>{t("Open NASA Moon Trek in a separate tab to explore its lunar map.")}</span></a>
    </div></section>;
}

export function SiteFooter() {
  const { t } = useLanguage();
  return <footer className="app-footer"><p>{t("Visibility alone does not measure solar power or radio signal strength.")}</p><p>{t("AI-assisted implementation ·")}{" "}<a href="https://github.com/justsomenewbie/moon-plan-b" target="_blank" rel="noreferrer">{t("Project repository")}</a> · <a href="https://github.com/justsomenewbie/moon-plan-b/issues" target="_blank" rel="noreferrer">{t("Project feedback")}</a></p>
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
      {/* Owner-supplied wording, the same in every language. Only lunar-navigator/ is MIT; see docs/CREDITS.md. */}
      <p className="footer-copyright" translate="no">© 2026 chungtrong.sae · Backend code under <a href="https://github.com/justsomenewbie/moon-plan-b/blob/main/lunar-navigator/LICENSE" target="_blank" rel="noopener noreferrer">MIT License</a></p>
    </footer>;
}
