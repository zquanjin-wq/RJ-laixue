import StudioContent from '../page';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function StudioPage() {
  return (
    <>
      <div className="absolute left-4 top-4 z-50 md:left-8 md:top-8">
        <Button asChild variant="outline" size="sm" className="bg-background/90">
          <Link href="/">
            <ArrowLeft className="mr-2 size-4" />
            返回教学驾驶舱
          </Link>
        </Button>
      </div>
      <StudioContent />
    </>
  );
}
