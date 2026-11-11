import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { login } from '@/app/actions/auth';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getUser()) redirect('/');
  const { error } = await searchParams;
  return (
    <div className="login card">
      <h1>Property Hazard Alerts</h1>
      {error && <div className="flash error">{error}</div>}
      <form action={login}>
        <label>
          Email
          <input type="email" name="email" required autoComplete="username" />
        </label>
        <label>
          Password
          <input type="password" name="password" required autoComplete="current-password" />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
