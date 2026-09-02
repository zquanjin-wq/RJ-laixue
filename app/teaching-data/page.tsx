import { AdminGate } from '@/components/auth-gate';
import { TeachingDataBoard } from '@/components/teaching-data-board';

export default function TeachingDataPage() {
  return (
    <AdminGate>
      <TeachingDataBoard />
    </AdminGate>
  );
}
