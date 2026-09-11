import { AdminGate } from '@/components/auth-gate';
import { TeachingDashboard } from '@/components/teaching-dashboard';

export default function TeachingDashboardPage() {
  return (
    <AdminGate>
      <TeachingDashboard />
    </AdminGate>
  );
}
