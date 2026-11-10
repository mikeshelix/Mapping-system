import { requireUser } from '@/lib/auth';
import { isUuid } from '@/lib/form';
import { MapView } from '@/components/MapView';

export default async function MapPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  await requireUser();
  const { event } = await searchParams;
  return <MapView focusEventId={event && isUuid(event) ? event : null} />;
}
