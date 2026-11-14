"use client";

import { useEffect } from "react";
import { useLanguage } from "./language";
import { SiteFooter, SiteHeader, SkyBackground, LunarResources } from "./site-chrome";
import { savedResultFromUrl } from "./observed-week";
import AstronautGuide from "./astronaut-guide";
import MoonGlobe from "./moon-globe";

const savedResult = savedResultFromUrl(new URLSearchParams());
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
          <p className="lead">{t("See when a lunar landing site can see both the Sun and Earth.")}</p>
          <div className="hero-actions">
            <a className="button primary" href="/plan?mode=sites">{t("Find sites for my dates")}</a>
            <a className="button outline" href="/plan?mode=dates">{t("Find dates for my site")}</a>
            <a href="/compare">{t("Open comparison tool")}</a>

          </div>
        </div>
        <MoonGlobe home savedResult={savedResult} />
      </section>
      <section className="home-about" id="about" tabIndex={-1} aria-labelledby="home-about-title">
        <h2 id="home-about-title">{t("About Moon Plan B")}</h2>
        <p>{t("At a lunar landing site, the Sun and Earth can rise above the local horizon at different times. Moon Plan B compares sites and dates to find when both are in view.")}</p>
        <a href="#team">{t("Meet the team behind Moon Plan B")}</a>
      </section>
      <section className="home-guide" id="home-guide" aria-labelledby="home-guide-title" tabIndex={-1}>
        <h2 id="home-guide-title">{t("Quick guide")}</h2>
        <ol>
          <li>{t("Open the example below. It compares two landing sites over the same week.")}</li>
          <li>{t("Compare the hours in bold. More hours means a longer time with both the Sun and Earth in view.")}</li>
          <li>{t("To try a different comparison, choose another week or select a site to compare its two weeks.")}</li>
        </ol>
        <a href="/compare#observed-week">{t("Try the saved example")}</a>
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
