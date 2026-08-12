import { AdminGate } from '@/components/auth-gate';
import { HomePage } from '../page';

export default function StudioPage() {
  return (
    <AdminGate>
      <HomePage />
    </AdminGate>
  );
}
