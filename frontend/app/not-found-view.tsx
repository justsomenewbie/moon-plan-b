"use client";

import { useLanguage } from "./language";
import { SiteFooter, SiteHeader, SkyBackground } from "./site-chrome";

export default function NotFoundView() {
  const { t } = useLanguage();
  return <div className="app-shell"><SkyBackground />
    <a className="skip-link" href="#not-found-title">{t("Skip to content")}</a>
    <SiteHeader />
    <main className="empty-state">
      <p className="eyebrow">404</p>
      <h1 id="not-found-title" tabIndex={-1}>{t("Page not found")}</h1>
      <p>{t("This page does not exist or has moved.")}</p>
      <div className="hero-actions">
        <a className="button primary" href="/">{t("Back to the home page")}</a>
        <a className="button outline" href="/compare">{t("Open comparison tool")}</a>
      </div>
    </main>
    <SiteFooter />
  </div>;
}
