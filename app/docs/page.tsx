import Link from 'next/link';
import { CHAPTERS } from '@/lib/docs';

export default function DocsIndexPage() {
  return (
    <article className="docs-content">
      <h1>RJ-la 老师操作手册</h1>
      <p>
        本手册面向锐捷大学培训部门老师，介绍如何使用 RJ-la 平台完成日常教学工作。
        手册基于当前 RJ-la 版本（v1.0）编写，随版本演进持续更新。
      </p>
      <h2>章节列表</h2>
      <div className="docs-index">
        {CHAPTERS.map((chapter) => (
          <Link
            key={chapter.slug}
            href={`/docs/${chapter.slug}`}
            className="docs-index-card"
          >
            <div className="docs-index-card-num">第 {chapter.order} 章</div>
            <h3 className="docs-index-card-title">{chapter.title}</h3>
            <p className="docs-index-card-summary">{chapter.summary}</p>
          </Link>
        ))}
      </div>
      <h2>阅读建议</h2>
      <ul>
        <li>
          <strong>首次使用</strong>：按顺序阅读「第 1 章 入门」→「第 2 章 创建新课件」→「第 5 章 上课播放」，建立基础认知。
        </li>
        <li>
          <strong>熟练使用</strong>：直接查阅附录 A FAQ 或按左侧章节定位。
        </li>
        <li>
          <strong>遇到问题</strong>：使用浏览器搜索（Ctrl+F）按关键字查找。
        </li>
      </ul>
      <h2>反馈与改进</h2>
      <p>
        如发现错误、遗漏或建议，反馈给培训管理员；紧急问题联系平台支持。
      </p>
    </article>
  );
}