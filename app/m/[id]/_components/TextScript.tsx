'use client';

/**
 * _components/TextScript.tsx
 *
 * Renders chapter narration as plain text split into paragraphs.
 *
 * Paragraph splitting rules (in priority order):
 *   1. Explicit \n\n / \n line breaks in the source text — used as-is.
 *   2. Chinese full stops (。！？) — split here so each sentence is its
 *      own paragraph. This gives the page a "podcast transcript" feel.
 *   3. English / Latin sentence terminators (.!?) — split here too.
 *
 * Auto-scrolls to follow the audio element when `active` is true.
 * Manual scrolling pauses auto-scroll for 3 seconds (so the user
 * can read a passage).
 */

import { useEffect, useMemo, useRef } from 'react';

interface TextScriptProps {
  text: string;
  active: boolean;
}

/**
 * Split text into paragraphs.
 *
 * If the text already contains newlines, treat those as the canonical
 * paragraph breaks. Otherwise, split after every Chinese full stop or
 * English sentence terminator that is followed by whitespace / start.
 */
function splitParagraphs(text: string): string[] {
  if (!text) return [];
  if (/\n/.test(text)) {
    return text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  }
  // No newlines — split at sentence terminators.
  const result: string[] = [];
  const re = /[^。！？.!?\n]+[。！？.!?]?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const p = match[0].trim();
    if (p) result.push(p);
  }
  // Fallback if regex matched nothing (defensive)
  return result.length > 0 ? result : [text];
}

export function TextScript({ text, active }: TextScriptProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastUserScrollRef = useRef(0);
  const paragraphs = useMemo(() => splitParagraphs(text), [text]);

  // Manual-scroll detection: pause auto-scroll for 3s after the user
  // touches the container.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      lastUserScrollRef.current = Date.now();
    };
    el.addEventListener('wheel', onScroll, { passive: true });
    el.addEventListener('touchstart', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onScroll);
      el.removeEventListener('touchstart', onScroll);
    };
  }, []);

  // Reset scroll to top whenever the text content changes (new chapter)
  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = 0;
  }, [text]);

  // Gentle auto-scroll when active and the user hasn't scrolled recently.
  useEffect(() => {
    if (!active) return;
    const el = containerRef.current;
    if (!el) return;
    const id = window.setInterval(() => {
      const sinceUser = Date.now() - lastUserScrollRef.current;
      if (sinceUser < 3000) return; // respect manual scroll
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      const next = Math.min(max, el.scrollTop + 20);
      el.scrollTop = next;
    }, 1000);
    return () => window.clearInterval(id);
  }, [active, text]);

  if (!text) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
        本章节没有文字稿
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mx-auto max-w-md w-full px-5 py-4 text-[15px] leading-[1.9] text-foreground"
    >
      {paragraphs.map((p, i) => (
        <p key={i} className="mb-4 last:mb-0 indent-[2em]">
          {p}
        </p>
      ))}
    </div>
  );
}