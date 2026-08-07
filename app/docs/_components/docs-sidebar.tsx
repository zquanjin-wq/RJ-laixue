'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { DocChapter } from '@/lib/docs';
import { cn } from '@/lib/utils';

interface DocsSidebarProps {
  readonly chapters: readonly DocChapter[];
}

export function DocsSidebar({ chapters }: DocsSidebarProps) {
  const pathname = usePathname();
  return (
    <aside className="docs-sidebar">
      <h2 className="docs-sidebar-title">RJ-la 老师手册</h2>
      <p className="docs-sidebar-tagline">锐捷大学培训部门 AI 课件平台操作指引</p>
      <ul className="docs-sidebar-list">
        <li>
          <Link
            href="/docs"
            className={cn('docs-sidebar-link', pathname === '/docs' && 'active')}
          >
            目录
          </Link>
        </li>
        {chapters.map((chapter) => {
          const href = `/docs/${chapter.slug}`;
          const isActive = pathname === href;
          return (
            <li key={chapter.slug}>
              <Link href={href} className={cn('docs-sidebar-link', isActive && 'active')}>
                {chapter.order}. {chapter.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}