import Link from 'next/link';
import { getFeedHealth, getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { logout } from '@/app/actions/auth';

export const dynamic = 'force-dynamic';

function ago(date: Date | null): string {
  if (!date) return 'never';
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return 'under a minute ago';
  if (mins < 90) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  return `${Math.round(mins / 60)} hours ago`;
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const feeds = await getFeedHealth(getSql());
  const stale = feeds.filter((f) => f.stale);

  return (
    <div className="shell">
      <nav className="topbar">
        <span className="brand">Hazard Alerts</span>
        <Link href="/">Map</Link>
        <Link href="/clients">Clients</Link>
        <Link href="/properties">Properties</Link>
        <Link href="/contacts">Contacts</Link>
        <Link href="/import">Import</Link>
        <Link href="/rules">Rules</Link>
        <Link href="/notifications">Notifications</Link>
        <Link href="/feeds">Feeds</Link>
        {user.role === 'admin' && <Link href="/users">Users</Link>}
        <span className="spacer" />
        <span className="who">
          {user.name} · {user.organizationName}
        </span>
        <form action={logout}>
          <button type="submit">Sign out</button>
        </form>
      </nav>
      {feeds.length === 0 && (
        <div className="banner">
          No hazard feed has reported yet. The worker process may not be running, so alerts are not being checked.
        </div>
      )}
      {stale.map((f) => (
        <div className="banner" key={f.feed}>
          The {f.feed.toUpperCase()} hazard feed last updated {ago(f.lastSuccessAt)}. Alerts may be delayed or missing
          until it recovers. Check official sources directly.
        </div>
      ))}
      <main className="main">{children}</main>
    </div>
  );
}
