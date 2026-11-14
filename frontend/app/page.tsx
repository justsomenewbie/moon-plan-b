"use client";

import { useEffect } from "react";
import { useLanguage } from "./language";
import { SiteFooter, SiteHeader, SkyBackground, LunarResources } from "./site-chrome";
import { savedResultFromUrl } from "./observed-week";
import { isMock } from "../lib/api/client";
import AstronautGuide from "./astronaut-guide";
import MoonGlobe from "./moon-globe";

const savedResult = savedResultFromUrl(new URLSearchParams());
const comparisonKeys = ["saved", "qa", "v", "mode", "a", "b", "sample", "duration", "h", "from", "to", "resolutionSeconds", "job", "run_id", "site_id", "view_site", "at"];

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
          <p className="lead">{t("See when a lunar landing site can see both the Sun and Earth.")}</p>
          <div className="hero-actions">
            <a className="button primary" href="/compare">{t("Open comparison tool")} <span aria-hidden="true">↗</span></a>
            <a className="button outline" href="#home-guide">{t("How to use Moon Plan B")}</a>
          </div>
        </div>
        <MoonGlobe home savedResult={savedResult} />
      </section>
      <section className="home-about" aria-labelledby="home-about-title">
        <h2 id="home-about-title">{t("About Moon Plan B")}</h2>
        <p>{t("Compare dates at one site, or compare sites over the same UTC window.")} {t("Visibility alone does not measure solar power or radio signal strength.")}</p>
      </section>
      <section className="home-guide" id="home-guide" aria-labelledby="home-guide-title" tabIndex={-1}>
        <h2 id="home-guide-title">{t("Quick guide")}</h2>
        <ol>
          <li>{t("Open the saved results and choose two sites in one week, or two weeks at one site.")}</li>
          <li>{t("Read the hours when both the Sun and Earth are visible. Choose a site from the list below the globe to inspect it.")}</li>
          <li>{!isMock ? t("Open the observation workspace to inspect the terrain model’s UTC intervals and coverage.") : t("For individual observations, open the timeline and move the slider to a UTC sample.")}</li>
        </ol>
        <a href="/compare#workspace">{t("Open the observation workspace")}</a>
      </section>
      <LunarResources />
    </main>
    <AstronautGuide savedResult={savedResult} terrain={null} comparisonPath="/compare" />
    <SiteFooter />
  </div>;
}
