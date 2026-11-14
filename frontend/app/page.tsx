"use client";

import { useEffect } from "react";
import { useLanguage } from "./language";
import { SiteFooter, SiteHeader, SkyBackground, LunarResources } from "./site-chrome";
import { savedResultFromUrl } from "./observed-week";
import AstronautGuide from "./astronaut-guide";
import MoonGlobe from "./moon-globe";

const savedResult = savedResultFromUrl(new URLSearchParams());
const exampleHref = "/compare?saved=2026-11-14T00%3A00%3A00Z#observed-week";
const comparisonKeys = ["saved", "qa", "v", "mode", "a", "b", "sample", "duration", "h", "from", "to", "resolutionSeconds", "job", "run_id", "site_id", "site_ids", "view_site", "at"];

export default function Home() {
  const { t } = useLanguage();
  useEffect(() => {
    function restoreComparisonLink() {
      const { search, hash } = window.location;
      const params = new URLSearchParams(search);
      // Published result links used the homepage before the comparison had its own route.
      const oldAnchor = /^#(workspace|observed-week|saved-model-source|sources|source-.+|local-sky|terrain-.+|data-error|site-assessments-title|comparison-title|mission-studio-title|qa-inspector-title|timeline-title|sky-title)$/.test(hash);
      if (comparisonKeys.some(key => params.has(key)) || oldAnchor) window.location.replace("/compare" + search + hash);
    }
    restoreComparisonLink();
    window.addEventListener("hashchange", restoreComparisonLink);
    return () => window.removeEventListener("hashchange", restoreComparisonLink);
  }, []);
  return <div className="app-shell">
    <SkyBackground />
    <a className="skip-link" href="#home-title">{t("Skip to content")}</a>
    <SiteHeader />
    <main>
      <section className="intro" aria-labelledby="home-title">
        <div className="hero-copy">
          <p className="eyebrow">{t("Lunar observation explorer")}</p>
          <h1 id="home-title" tabIndex={-1}>{t("Find a clearer window")}</h1>
          <p className="lead">{t("Near the lunar south pole, the Sun stays low. Compare landing sites and dates to see how many hours both the Sun and Earth are in view.")}</p>
          <div className="hero-actions">
            <a className="button primary" href="/orbit">{t("Explore the landing sites")}</a>
            <a className="button outline" href="#home-guide">{t("How to use Moon Plan B")}</a>
          </div>
        </div>
        <MoonGlobe home savedResult={savedResult} />
      </section>
      <section className="home-about" id="about" tabIndex={-1} aria-labelledby="home-about-title">
        <div>
          <h2 id="home-about-title">{t("How a crater changes the view")}</h2>
          <p>{t("A ridge can catch sunlight while the crater floor lies in shadow. From the ridge, Earth is visible only when it clears the terrain in its own direction.")}</p>
          <p>{t("Moon Plan B counts the hours when both are visible. Estimating solar power or radio performance takes additional information about the lander.")}</p>
          <a href="#team">{t("Meet the team behind Moon Plan B")}</a>
        </div>
        <figure className="crater-profile">
          <svg viewBox="0 0 400 171" role="img" aria-labelledby="crater-description">
            <title id="crater-description">{t("Low sunlight reaches the left rim. The floor is shadowed. A dotted line connects the rim to Earth above the opposite slope.")}</title>
            <circle cx="29" cy="55" r="10" fill="var(--sun)" />
            <text x="17" y="33" fill="var(--sun)">{t("Sun")}</text>
            <circle cx="369" cy="29" r="9" fill="var(--earth)" />
            <text x="387" y="58" textAnchor="end" fill="var(--earth)">{t("Earth")}</text>
            <path d="M44 57 L129 75" fill="none" stroke="var(--sun)" strokeWidth="2" />
            <path d="M129 75 L357 31" fill="none" stroke="var(--earth)" strokeWidth="2" strokeDasharray="3 5" />
            <path d="M0 107 L34 101 L74 94 L106 79 L129 75 L150 91 Q184 131 221 133 Q253 134 277 112 L316 84 L334 89 L354 86 L400 99 V171 H0 Z" fill="var(--below-horizon)" />
            <path d="M0 107 L34 101 L74 94 L106 79 L129 75" fill="none" stroke="var(--sun)" strokeWidth="2.5" />
            <path d="M129 75 L150 91 Q184 131 221 133 Q253 134 277 112 L316 84 L334 89 L354 86 L400 99" fill="none" stroke="var(--horizon)" strokeWidth="2" />
            <circle cx="129" cy="75" r="3.5" fill="var(--text)" />
            <text x="121" y="55" textAnchor="middle" fill="var(--text)">{t("Sunlit rim")}</text>
            <path d="M221 134 v9" stroke="var(--horizon)" />
            <text x="221" y="163" textAnchor="middle" fill="var(--text)">{t("Shadowed floor")}</text>
          </svg>
          <figcaption>{t("AI-assisted illustration · Terrain and angles are schematic.")}</figcaption>
        </figure>
      </section>
      <section className="home-guide" id="home-guide" aria-labelledby="home-guide-title" tabIndex={-1}>
        <h2 id="home-guide-title">{t("Quick guide")}</h2>
        <ol>
          <li>{t("Open the example below. It compares two landing sites over the same week.")}</li>
          <li>{t("Compare the hours in bold. More hours means a longer time with both the Sun and Earth in view.")}</li>
          <li>{t("To try a different comparison, choose another week or select a site to compare its two weeks.")}</li>
        </ol>
        <a href={exampleHref}>{t("Earlier example · run B")}</a>
        <div className="home-guide-links">
          <a href="/plan?mode=sites">{t("Find sites for my dates")}</a>
          <a href="/plan?mode=dates">{t("Find dates for my site")}</a>
          <a href="/compare">{t("Open comparison tool")}</a><a href="/data">{t("Data catalog")}</a></div>
      </section>
      <section id="team" className="home-team" tabIndex={-1} aria-labelledby="team-title">
        <h2 id="team-title">{t("Team members")}</h2>
        <ul>{["Nguyen Trong Chung", "Nguyen Thuy Trang", "Chu Hoang Lam", "Man Gia Minh", "Nguyen Nhu Son", "Nguyen Phuong Thao"].map(name => <li key={name}>{name}</li>)}</ul>
      </section>
      <LunarResources />
    </main>
    <AstronautGuide savedResult={savedResult} terrain={null} comparisonPath="/compare" />
    <SiteFooter />
  </div>;
}
