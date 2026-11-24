'use client';

import { useEffect } from 'react';
import { handleSitePopupClick } from '@/lib/sitePopup';

/** Makes every link marked data-site-popup open in a small separate window, on every page of the app. */
export function SitePopupLinks() {
  useEffect(() => {
    document.addEventListener('click', handleSitePopupClick);
    return () => document.removeEventListener('click', handleSitePopupClick);
  }, []);
  return null;
}
