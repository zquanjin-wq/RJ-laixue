import { AdminGate } from '@/components/auth-gate';
import { TeachingDashboard } from '@/components/teaching-dashboard';

export default function Page() {
  return (
    <AdminGate>
      <TeachingDashboard />
    </AdminGate>
  );
}
