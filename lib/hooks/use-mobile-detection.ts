/**
 * lib/hooks/use-mobile-detection.ts
 *
 * Client-side mobile device detection for automatic route switching.
 * Uses a dual-strategy approach:
 *
 *   1. User-Agent string matching (primary) — catches phones and tablets.
 *   2. Viewport width fallback (secondary) — catches desktop browsers
 *      resized below 768px or devices with spoofed UAs.
 *
 * Returns `isMobile: boolean` after hydration (always false during SSR
 * to avoid hydration mismatch). The value updates on window resize so
 * users who rotate their phone or use split-screen get correct behavior.
 */

'use client';

import { useEffect, useState } from 'react';

/** UA keywords that indicate a mobile / tablet device. */
const MOBILE_UA_RE = /mobile|android|iphone|ipad|ipod|blackberry|opera mini|iemobile/i;

/**
 * Check User-Agent string for mobile indicators.
 * Safe to call in any environment — returns false if navigator is absent.
 */
function checkUA(): boolean {
  if (typeof navigator === 'undefined') return false;
  return MOBILE_UA_RE.test(navigator.userAgent);
}

/**
 * Check viewport width against the md breakpoint (768px).
 */
function checkViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < 768;
}

export interface MobileDetection {
  /** True when running on a mobile device or narrow viewport. */
  isMobile: boolean;
}

/**
 * React hook that returns stable mobile detection state.
 *
 * - SSR / pre-hydration: `{ isMobile: false }` (safe default).
 * - Post-hydration: evaluated once, then re-evaluated on resize.
 */
export function useMobileDetection(): MobileDetection {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    // Initial evaluation after hydration
    const evaluate = () => setIsMobile(checkUA() || checkViewport());
    evaluate();

    // Re-evaluate on resize (debounced via rAF to avoid thrashing)
    let rafId = 0;
    const onResize = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(evaluate);
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(rafId);
    };
  }, []);

  return { isMobile };
}
