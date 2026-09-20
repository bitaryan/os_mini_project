import { LiveDashboard } from '../../components/live-dashboard';
import { fetchReadiness } from '../../lib/api/readiness';
import { readWebEnv } from '../../lib/env';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const env = readWebEnv();
  const health = await fetchReadiness(env.API_INTERNAL_URL);
  return (
    <LiveDashboard
      apiUrl={env.NEXT_PUBLIC_API_URL}
      socketUrl={env.NEXT_PUBLIC_SOCKET_URL}
      environment={env.NEXT_PUBLIC_APP_ENV}
      initiallyReady={health?.status === 'ready'}
    />
  );
}
