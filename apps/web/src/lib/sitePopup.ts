/**
 * Business websites open in their own small window, so the map and the list of businesses
 * stay exactly as they were behind it. Links are marked with data-site-popup; one listener
 * on the page handles them all, including links inside map pop-ups.
 */
export const SITE_POPUP_ATTR = 'data-site-popup';

/** Opens a web address in a separate window beside the app. The site gets no handle back to this page. */
export function openSiteWindow(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const width = Math.max(480, Math.min(1100, window.screen.availWidth - 120));
  const height = Math.max(480, Math.min(820, window.screen.availHeight - 120));
  const left = Math.max(0, window.screenX + window.outerWidth - width - 40);
  const top = Math.max(0, window.screenY + 60);
  window.open(url, '_blank', `popup=yes,width=${width},height=${height},left=${left},top=${top},noopener,noreferrer`);
}

/** Click handler for the whole page. Ctrl, Cmd, Shift and middle clicks are left alone, so "open in a new tab" still works. */
export function handleSitePopupClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element | null)?.closest?.(`a[${SITE_POPUP_ATTR}]`) as HTMLAnchorElement | null;
  if (!link?.href) return;
  event.preventDefault();
  openSiteWindow(link.href);
}
