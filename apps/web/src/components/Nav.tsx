'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Item {
  href: string;
  label: string;
  adminOnly?: boolean;
}
interface Section {
  label: string;
  items: Item[];
}

/** Four places to go. Everything else lives one click inside one of them. */
const SECTIONS: Section[] = [
  { label: 'Map', items: [{ href: '/', label: 'Map' }] },
  {
    label: 'Portfolio',
    items: [
      { href: '/clients', label: 'Clients' },
      { href: '/properties', label: 'Locations' },
      { href: '/contacts', label: 'Contacts' },
      { href: '/import', label: 'Import a list' },
    ],
  },
  {
    label: 'Alerts',
    items: [
      { href: '/impacts', label: 'Affected now' },
      { href: '/rules', label: 'Alert rules' },
      { href: '/notifications', label: 'Sent messages' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { href: '/feeds', label: 'Data feeds' },
      { href: '/users', label: 'Users', adminOnly: true },
      { href: '/settings', label: 'Settings', adminOnly: true },
    ],
  },
];

const inside = (path: string, href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));

/** Main menu for the top bar. */
export function MainNav({ isAdmin }: { isAdmin: boolean }) {
  const path = usePathname();
  return (
    <>
      {SECTIONS.map((s) => {
        const items = s.items.filter((i) => isAdmin || !i.adminOnly);
        const active = items.some((i) => inside(path, i.href));
        return (
          <Link key={s.label} href={items[0]!.href} className={active ? 'on' : ''} aria-current={active ? 'page' : undefined}>
            {s.label}
          </Link>
        );
      })}
    </>
  );
}

/** Second row: the pages inside the current section. Hidden on the map, which has no siblings. */
export function SubNav({ isAdmin }: { isAdmin: boolean }) {
  const path = usePathname();
  const section = SECTIONS.find((s) => s.items.some((i) => inside(path, i.href)));
  const items = (section?.items ?? []).filter((i) => isAdmin || !i.adminOnly);
  if (!section || items.length < 2) return null;
  return (
    <nav className="subnav" aria-label={section.label}>
      {items.map((i) => (
        <Link key={i.href} href={i.href} className={inside(path, i.href) ? 'on' : ''} aria-current={inside(path, i.href) ? 'page' : undefined}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
