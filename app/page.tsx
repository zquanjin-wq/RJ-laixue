import { AdminGate } from '@/components/auth-gate';
import { HomePage } from '@/components/home-page';

export default function Page() {
  return (
    <AdminGate>
      <HomePage />
    </AdminGate>
  );
}
