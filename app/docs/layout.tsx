import { ReactNode } from 'react';
import { CHAPTERS } from '@/lib/docs';
import { DocsSidebar } from './_components/docs-sidebar';
import '@/app/docs/docs.css';

interface DocsLayoutProps {
  readonly children: ReactNode;
}

export const metadata = {
  title: 'RJ-la 老师操作手册',
  description: '锐捷大学培训部门老师使用手册',
};

export default function DocsLayout({ children }: DocsLayoutProps) {
  return (
    <div className="docs-shell">
      <DocsSidebar chapters={CHAPTERS} />
      <main className="docs-main">{children}</main>
    </div>
  );
}