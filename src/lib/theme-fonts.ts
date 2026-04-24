const THEME_FONT_LINK_ID = "theme-fonts";

export function getThemeFontHref(theme: string) {
  if (theme === "night") {
    return "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap";
  }
  return null;
}

function ensurePreconnect(head: HTMLHeadElement, href: string, crossOrigin = false) {
  const existing = head.querySelector(`link[rel="preconnect"][href="${href}"]`);
  if (existing) return;
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = href;
  if (crossOrigin) link.crossOrigin = "";
  head.appendChild(link);
}

export function ensureThemeFont(theme: string) {
  if (typeof document === "undefined") return;

  const head = document.head;
  const href = getThemeFontHref(theme);
  const existing = document.getElementById(THEME_FONT_LINK_ID) as HTMLLinkElement | null;

  if (!href) {
    existing?.remove();
    return;
  }

  ensurePreconnect(head, "https://fonts.googleapis.com");
  ensurePreconnect(head, "https://fonts.gstatic.com", true);

  if (existing?.href === href) return;

  const link = existing ?? document.createElement("link");
  link.id = THEME_FONT_LINK_ID;
  link.rel = "stylesheet";
  link.href = href;

  if (!existing) {
    head.appendChild(link);
  }
}
