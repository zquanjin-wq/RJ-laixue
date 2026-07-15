'use client';

/**
 * _components/TextScript.tsx
 *
 * Renders chapter narration as plain text. Auto-scrolls to follow
 * the audio element when `active` is true. Manual scrolling pauses
 * auto-scroll for 3 seconds (so the user can read a passage).
 */

import { useEffect, useRef } from 'react';

interface TextScriptProps {
  text: string;
  active: boolean;
}

export function TextScript({ text, active }: TextScriptProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastUserScrollRef = useRef(0);

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

  // Reset scroll to top whenever text changes (new chapter)
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
      // Slowly drift downward
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
      className="mx-auto max-w-md w-full px-4 py-2 text-base leading-relaxed text-foreground whitespace-pre-wrap"
    >
      {text}
    </div>
  );
}