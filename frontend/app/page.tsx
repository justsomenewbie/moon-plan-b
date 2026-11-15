"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "./language";
import { SiteFooter, SiteHeader, SkyBackground, LunarResources } from "./site-chrome";
import { ComparisonExample, savedResultFromUrl } from "./observed-week";
import AstronautGuide from "./astronaut-guide";
import MoonGlobe from "./moon-globe";

// Structured data for search engines; plain constants, so the markup is identical on the server and the client.
const structuredData = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Moon Plan B",
  alternateName: "Lunar Navigator",
  url: "https://lunavigator.com/",
  image: "https://lunavigator.com/brand/og-image.png",
  description: "Compare lunar south-pole landing sites and dates by the hours the Sun and Earth are both above the local horizon, using NASA LRO terrain and JPL Horizons data.",
  applicationCategory: "EducationalApplication",
  operatingSystem: "Any",
  browserRequirements: "Requires JavaScript and a modern web browser.",
  inLanguage: ["en", "vi"],
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  creator: { "@type": "Organization", name: "Moon Plan B team", url: "https://lunavigator.com/#team" },
}).replace(/</g, "\\" + "u003c");

const comparisonKeys = ["saved", "qa", "v", "mode", "a", "b", "sample", "duration", "h", "from", "to", "resolutionSeconds", "job", "run_id", "site_id", "site_ids", "view_site", "at"];

// Team photos live in public/team as <file>.webp with a .jpg fallback.
const team = [
  // Each member's own quote, shown as written (not translated).
  ["Nguyen Trong Chung", "nguyen-trong-chung", "Even the Moon needs its Earth."],
  ["Nguyen Phuong Thao", "nguyen-phuong-thao", "Born to be Spider-Man."],
  ["Chu Hoang Lam", "chu-hoang-lam", "Bring it on."],
  ["Man Gia Minh", "man-gia-minh", "Beyond the sky, beyond the limits."],
  ["Nguyen Nhu Son", "nguyen-nhu-son", "The dark isn't empty."],
  ["Nguyen Thuy Trang", "nguyen-thuy-trang", "I yearn for the mines."],
] as const;

export default function Home() {
  const { t, locale } = useLanguage();
  const [savedResult, setSavedResult] = useState(() => savedResultFromUrl(new URLSearchParams()));
  const comparisonPath = "/compare?saved=" + encodeURIComponent(savedResult);
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
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData }} />
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
            <a className="button primary" href="/compare"><span>{t("Open comparison tool")}</span><span aria-hidden="true">↗</span></a>
            <a className="button outline" href="/plan">{t("Plan a lunar visit")}</a>
            <a className="button outline" href="#home-guide">{t("How to use Moon Plan B")}</a>
          </div>
        </div>
        <MoonGlobe home />
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
            <circle cx="29" cy="55" r="10" fill="var(--sun-fill)" />
            <text x="17" y="33" fill="var(--sun)">{t("Sun")}</text>
            <circle cx="369" cy="29" r="9" fill="var(--earth)" />
            <text x="387" y="58" textAnchor="end" fill="var(--earth)">{t("Earth")}</text>
            <path d="M44 57 L129 75" fill="none" stroke="var(--sun-fill)" strokeWidth="2" />
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
        <ComparisonExample selection={savedResult} onSelect={setSavedResult} comparisonPath={comparisonPath} />
        <details className="home-walkthrough" open>
          <summary>{t("How do I find a site for my dates?")}</summary>
          <p>{t("Try the week of November 14–20, 2026 (UTC). You can then change the dates.")}</p>
          <a href="/plan?mode=sites&source=saved-b2&from=2026-11-14&to=2026-11-21&priority=joint">{t("Open this planner example")}</a>
          <ol>
            {[
              ["Choose your dates", "Select “I have dates”. Start on November 14 and end on November 21. The last day counted is November 20."],
              ["Choose what to compare", "Select “Sun and Earth together” and press “Find sites” to rank sites by the hours when both are visible."],
              ["Read the map and table", "Find Vikram’s gold diamond on the map. In its table row, “Both visible (h)” reads 162. That is how many of the week’s 168 hours both the Sun and Earth were visible. Select another dot to see that site’s hours."],
            ].map(([title, instruction], index) => <li key={title}>
              <strong>{t(title)}</strong>
              <p>{t(instruction)}</p>
              <img src={`/images/guide/plan-step-${index + 1}-${locale}.webp`} width={640}
                height={(locale === "vi" ? [594, 340, 738] : [510, 340, 654])[index]} alt="" loading="lazy" />
            </li>)}
          </ol>
        </details>
        <div className="home-guide-links">
          <a href="/plan?mode=sites">{t("Find sites for my dates")}</a>
          <a href="/plan?mode=dates">{t("Find dates for my site")}</a>
          <a href="/data">{t("Data catalog")}</a>
          <a href="/orbit">{t("Orbit view")}</a>
        </div>
      </section>
      <section id="team" className="home-team" tabIndex={-1} aria-labelledby="team-title">
        <h2 id="team-title">{t("Team members")}</h2>
        <ul>{team.map(([name, file, quote]) => <li key={file}>
          <div className="team-frame"><picture>
            <source srcSet={`/team/${file}.webp`} type="image/webp" />
            <img src={`/team/${file}.jpg`} width={172} height={172} loading="lazy" alt={`Photo of ${name}`} />
          </picture></div>
          <span>{name}</span>
          <q className="team-quote" lang="en">{quote}</q>
        </li>)}</ul>
      </section>
      <LunarResources />
    </main>
    <AstronautGuide savedResult={savedResult} terrain={null} comparisonPath={comparisonPath} />
    <SiteFooter />
  </div>;
}
