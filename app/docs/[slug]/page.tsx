import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  CHAPTERS,
  getChapterBySlug,
  getChapterSource,
  getAdjacentChapters,
} from '@/lib/docs';
import { renderMarkdown } from '@/lib/docs/markdown';

interface ChapterPageProps {
  readonly params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return CHAPTERS.map((chapter) => ({ slug: chapter.slug }));
}

export async function generateMetadata({ params }: ChapterPageProps) {
  const { slug } = await params;
  const chapter = getChapterBySlug(slug);
  if (!chapter) return {};
  return {
    title: `${chapter.title} · RJ-la 老师手册`,
    description: chapter.summary,
  };
}

export default async function ChapterPage({ params }: ChapterPageProps) {
  const { slug } = await params;
  const chapter = getChapterBySlug(slug);
  if (!chapter) notFound();
  const source = getChapterSource(slug);
  if (source === null) notFound();
  const html = renderMarkdown(source);
  const { prev, next } = getAdjacentChapters(slug);

  return (
    <article className="docs-content">
      <header style={{ marginBottom: '0.5rem' }}>
        <span
          style={{
            fontSize: '0.75rem',
            color: 'var(--docs-muted, #6b7280)',
            fontWeight: 600,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          第 {chapter.order} 章
        </span>
      </header>
      <h1 style={{ marginTop: 0 }}>{chapter.title}</h1>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <nav className="docs-nav">
        {prev ? (
          <Link href={`/docs/${prev.slug}`} className="docs-nav-link prev">
            <span className="docs-nav-direction">← 上一章</span>
            <span className="docs-nav-title">{prev.title}</span>
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={`/docs/${next.slug}`} className="docs-nav-link next">
            <span className="docs-nav-direction">下一章 →</span>
            <span className="docs-nav-title">{next.title}</span>
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </article>
  );
}