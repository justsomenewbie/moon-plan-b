import { useEffect, useId, useRef } from "react";
import type { MouseEvent } from "react";
import { useLanguage } from "./language";

// Pointer hits may cover several projected sites. Keyboard activation already identifies a named pin.
export function sitesAtPointer(event: MouseEvent<Element>): string[] {
  if (!event.detail) return [];
  const surface = event.currentTarget.closest(".lunar-frame, .plan-map-surface");
  const ids = new Set<string>();
  for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
    const pin = element.closest("[data-site]");
    const id = pin?.getAttribute("data-site");
    if (id && surface?.contains(pin)) ids.add(id);
  }
  return [...ids];
}

export function SitePinPicker({ sites, onClose }: {
  sites: { id: string; name: string; select: () => void }[];
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const title = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="site-pin-picker" aria-labelledby={title}
    onCancel={event => event.stopPropagation()} onClose={event => { event.stopPropagation(); onClose(); }}>
    <h3 id={title}>{t("Choose a site at this point")}</h3>
    <div className="grid gap-2 my-3">{sites.map(site => <button type="button" className="button outline" key={site.id}
      onClick={() => { dialog.current?.close(); site.select(); }}>{site.name}</button>)}</div>
    <button type="button" className="button outline" onClick={() => dialog.current?.close()}>{t("Cancel")}</button>
  </dialog>;
}
