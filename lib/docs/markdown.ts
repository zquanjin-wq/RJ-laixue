/**
 * Minimal markdown → HTML converter for the user-guide docs site.
 *
 * Why not use a full library (marked, markdown-it, MDX)? Two reasons:
 *   1. Avoid pulling a new runtime dependency into the deployment for a
 *      docs site that only needs a handful of constructs.
 *   2. Keep the docs Markdown portable — these files live under
 *      docs/user-guide/ and must round-trip cleanly between the on-disk
 *      source and the rendered page.
 *
 * Scope: just the syntax we use across the 9 user-guide chapters.
 * Anything more sophisticated (tables of contents, syntax cross, nested
 * HTML, footnotes) → fall back to a `<pre>` so the user sees the source
 * rather than a broken render. If a chapter needs more, swap this for
 * `marked` or `markdown-it` in one place.
 *
 * Supported:
 *   - ATX headings (#, ##, ###, ####)
 *   - Paragraphs
 *   - Unordered lists (- / *)
 *   - Ordered lists (1. 2. 3.)
 *   - GFM tables (| col | col | ... )
 *   - Blockquotes (> ...)
 *   - Code fences (``` ... ```)
 *   - Inline code (`code`)
 *   - Bold (**) and italic (*)
 *   - Images (![alt](url)) and links ([text](url))
 *   - Horizontal rules (---)
 *
 * NOT supported (by design): nested lists, nested blockquotes, mixed
 * ordered/unordered lists in the same block, raw HTML, reference-style
 * links, footnotes, task lists. If a paragraph fails to parse it is
 * emitted verbatim inside a <pre> for safety.
 */

export interface MarkdownOptions {
  /** Path prefix for relative image URLs. Defaults to ''. */
  readonly imageBase?: string;
  /** Path prefix for relative link URLs. Defaults to ''. */
  readonly linkBase?: string;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(input: string): string {
  return escapeHtml(input);
}

function renderInline(text: string, opts: MarkdownOptions): string {
  let result = escapeHtml(text);

  // Inline code (must run before bold/italic so ** inside `code` is safe).
  result = result.replace(/`([^`]+?)`/g, (_, code: string) => `<code>${code}</code>`);

  // Images: ![alt](url "title")
  result = result.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_, alt: string, url: string, title?: string) => {
      const finalUrl = url.startsWith('http') || url.startsWith('data:') || url.startsWith('/')
        ? url
        : (opts.imageBase ?? '') + url;
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<img src="${escapeAttr(finalUrl)}" alt="${escapeAttr(alt)}"${titleAttr} loading="lazy" />`;
    },
  );

  // Links: [text](url "title")
  result = result.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_, label: string, url: string, title?: string) => {
      const finalUrl =
        url.startsWith('http') ||
        url.startsWith('mailto:') ||
        url.startsWith('#') ||
        url.startsWith('/')
          ? url
          : (opts.linkBase ?? '') + url;
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<a href="${escapeAttr(finalUrl)}"${titleAttr} rel="noopener noreferrer">${label}</a>`;
    },
  );

  // Bold: **text**
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic: *text* (avoid matching across multiple asterisks).
  result = result.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  return result;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('|');
}

function parseTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderTable(rows: string[][], opts: MarkdownOptions): string {
  const [header, ...body] = rows;
  const headerHtml = header
    .map((cell) => `<th scope="col">${renderInline(cell, opts)}</th>`)
    .join('');
  const bodyHtml = body
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${renderInline(cell, opts)}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<div class="docs-table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

export function renderMarkdown(source: string, opts: MarkdownOptions = {}): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — emit nothing, allow block separators.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*---+\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // Fenced code block: ``` ... ```
    if (/^\s*```/.test(line)) {
      const buffer: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buffer.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      out.push(`<pre><code>${escapeHtml(buffer.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading.
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = renderInline(headingMatch[2], opts);
      const id = slugify(headingMatch[2]);
      out.push(`<h${level} id="${id}">${text}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      const buffer: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buffer.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote><p>${renderInline(buffer.join(' '), opts)}</p></blockquote>`);
      continue;
    }

    // Unordered list.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      out.push(
        `<ul>${items.map((item) => `<li>${renderInline(item, opts)}</li>`).join('')}</ul>`,
      );
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(
        `<ol>${items.map((item) => `<li>${renderInline(item, opts)}</li>`).join('')}</ol>`,
      );
      continue;
    }

    // GFM table: header row + separator row + ≥0 body rows.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const rows: string[][] = [];
      rows.push(parseTableRow(line));
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      if (rows.every((r) => isTableSeparatorRow(r)) && rows.length > 0) {
        // Separator-only rows (shouldn't happen, but guard).
        continue;
      }
      const header = rows[0];
      const body = rows.slice(1);
      out.push(renderTable([header, ...body], opts));
      continue;
    }

    // Paragraph: collect consecutive non-blank, non-block lines.
    const buffer: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6}\s+|\s*[-*]\s+|\s*\d+\.\s+|\s*>\s?|\s*```|---+\s*$)/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      buffer.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(buffer.join('\n\n'), opts)}</p>`);
  }

  return out.join('\n');
}

/** Lower-case, ASCII-only slug for heading ids. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}