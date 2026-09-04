'use client';

import { useEffect, useState } from 'react';
import { Film, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface VideoExportCapabilityResponse {
  success: boolean;
  capability?: {
    available: boolean;
    message: string;
  };
}

export interface VideoExportShellProps {
  courseId: string;
  className?: string;
}

const unavailableMessage = '??????????????????????';

export function VideoExportShell({ courseId, className }: VideoExportShellProps) {
  const [message, setMessage] = useState(unavailableMessage);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    async function loadCapability() {
      try {
        const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/video-exports`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        const payload = (await response.json()) as VideoExportCapabilityResponse;
        if (payload.capability?.message) setMessage(payload.capability.message);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setMessage('???????????????');
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }
    void loadCapability();
    return () => controller.abort();
  }, [courseId]);

  return (
    <Card className={cn('gap-4', className)} size="sm">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Film className="size-4" />
            ????
          </CardTitle>
          <Badge variant="secondary">{isLoading ? '???' : '???'}</Badge>
        </div>
        <CardDescription>?????????????????</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm" role="status">
          {message}
        </p>
        <Button disabled size="sm" variant="outline">
          <RefreshCw />
          ????
        </Button>
      </CardContent>
    </Card>
  );
}
