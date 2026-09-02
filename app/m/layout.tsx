/**
 * app/m/layout.tsx
 *
 * Mobile learner entry — compact layout, mobile-first viewport,
 * theme color matching the brand green (#16a34a). No site-wide
 * nav, no admin chrome, no Pro Mode. Just the learning surface.
 */

import type { Metadata, Viewport } from 'next';
import '../globals.css';

export const metadata: Metadata = {
  title: '来学 · 创课助手',
  description: '学员移动端 · 通勤场景下的 AI 互动学习',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#16a34a',
};

export default function MobileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      {children}
    </div>
  );
}