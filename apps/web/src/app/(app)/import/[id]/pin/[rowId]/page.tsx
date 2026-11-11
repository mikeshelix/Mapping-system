import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { isUuid } from '@/lib/form';
import { Flash, type Search } from '@/components/Flash';
import { PinPicker } from '@/components/PinPicker';
import { setImportPin } from '@/app/actions/import';

export default async function ImportPinPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; rowId: string }>;
  searchParams: Search;
}) {
  const user = await requireUser();
  const { id, rowId } = await params;
  if (!isUuid(id) || !isUuid(rowId)) notFound();
  const [row] = await getSql()`
    SELECT r.id, r.row_number, r.name, r.address, r.city, r.state, r.zip, r.lon, r.lat
    FROM import_rows r JOIN import_batches b ON b.id = r.batch_id
    WHERE r.id = ${rowId} AND b.id = ${id} AND b.organization_id = ${user.organizationId} AND b.status = 'review'`;
  if (!row) notFound();

  return (
    <div className="page">
      <h1>Set pin: {row.name}</h1>
      <Flash search={searchParams} />
      <div className="card">
        <p>
          Row {row.row_number}: {[row.address, row.city, row.state, row.zip].filter(Boolean).join(', ') || 'no address'}
        </p>
        <form action={setImportPin}>
          <input type="hidden" name="row_id" value={row.id} />
          <PinPicker initial={row.lon != null && row.lat != null ? { lon: Number(row.lon), lat: Number(row.lat) } : null} />
          <div className="row" style={{ marginTop: 12 }}>
            <button type="submit">Save pin</button>
            <Link href={`/import/${id}`}>Cancel</Link>
          </div>
        </form>
      </div>
    </div>
  );
}
