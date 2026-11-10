import { getSql } from '@hazard/db';
import { requireAdmin } from '@/lib/auth';
import { Flash, type Search } from '@/components/Flash';
import { createUser, deleteUser } from '@/app/actions/auth';

export default async function UsersPage({ searchParams }: { searchParams: Search }) {
  const admin = await requireAdmin();
  const users = await getSql()`
    SELECT id, name, email, role FROM users WHERE organization_id = ${admin.organizationId} ORDER BY name`;

  return (
    <div className="page">
      <h1>Users · {admin.organizationName}</h1>
      <Flash search={searchParams} />
      <div className="card">
        <h2>Add a staff account</h2>
        <form action={createUser} className="grid">
          <label>
            Name
            <input type="text" name="name" required />
          </label>
          <label>
            Email
            <input type="email" name="email" required />
          </label>
          <label>
            Temporary password
            <input type="password" name="password" required minLength={10} autoComplete="new-password" />
          </label>
          <label>
            Role
            <select name="role" defaultValue="staff">
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button type="submit">Add user</button>
        </form>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>
                  {u.id !== admin.id && (
                    <form action={deleteUser}>
                      <input type="hidden" name="id" value={u.id} />
                      <button type="submit" className="link">
                        Remove
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
