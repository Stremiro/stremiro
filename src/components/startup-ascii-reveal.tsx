import { useEffect, useRef, useState } from 'react';

const SWEEP_DURATION_MS = 540;
const TRAIL_BAND_WIDTH = 0.135;
const CREST_WIDTH = 0.024;
const SAFETY_TIMEOUT_MS = 1_600;
const REVEAL_READY_FALLBACK_MS = 1_500;
const CELL_WIDTH_PX = 24;
const CELL_HEIGHT_PX = 26;
const GLYPH_STEP_MS = 56;
const MAX_DPR = 1.5;

// Minimal hairline and micro-dot glyphs for a sleek, restrained sweep.
const CREST_GLYPHS = ['·', '∘', '∙', '+', '×'] as const;
const WAKE_GLYPHS = ['·', '.', ':', '˙', '┄'] as const;

interface AccentRgb {
  r: number;
  g: number;
  b: number;
}

interface GlyphGrid {
  width: number;
  height: number;
  dpr: number;
  count: number;
  cellX: Float32Array;
  cellY: Float32Array;
  cellDiag: Float32Array;
  cellSeed: Uint8Array;
}

const DEFAULT_ACCENT: AccentRgb = { r: 226, g: 232, b: 240 };

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function cellHash(col: number, row: number): number {
  let n = Math.imul(col + 17, 374_761_393) ^ Math.imul(row + 31, 668_265_263);
  n = Math.imul(n ^ (n >>> 13), 2_246_822_519);
  return ((n ^ (n >>> 16)) >>> 0) & 0xff;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return true;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function readAccentState(): { rgb: AccentRgb; glowFactor: number } {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return { rgb: DEFAULT_ACCENT, glowFactor: 1 };
  }
  const style = getComputedStyle(document.documentElement);
  const rawRgb = style.getPropertyValue('--app-accent-rgb').trim();
  const parts = rawRgb.split(/[\s,]+/).filter(Boolean);
  let rgb = DEFAULT_ACCENT;
  if (parts.length >= 3) {
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      rgb = {
        r: Math.max(0, Math.min(255, Math.round(r))),
        g: Math.max(0, Math.min(255, Math.round(g))),
        b: Math.max(0, Math.min(255, Math.round(b))),
      };
    }
  }

  // Keep a refined baseline even when ambient glow is turned down to 0,
  // and lift very dark custom accents so the sweep stays subtly visible on black.
  const maxChannel = Math.max(rgb.r, rgb.g, rgb.b);
  if (maxChannel < 110) {
    rgb = mixHighlight(rgb, (110 - maxChannel) / (255 - maxChannel));
  }
  const rawGlow = Number(style.getPropertyValue('--app-glow').trim());
  const glow = Number.isFinite(rawGlow) ? clamp01(rawGlow) : 1;
  return { rgb, glowFactor: 0.58 + 0.42 * glow };
}

function mixHighlight(rgb: AccentRgb, weight: number): AccentRgb {
  return {
    r: Math.round(rgb.r + (255 - rgb.r) * weight),
    g: Math.round(rgb.g + (255 - rgb.g) * weight),
    b: Math.round(rgb.b + (255 - rgb.b) * weight),
  };
}

function buildGrid(width: number, height: number, dpr: number): GlyphGrid {
  const cols = Math.max(1, Math.ceil(width / CELL_WIDTH_PX));
  const rows = Math.max(1, Math.ceil(height / CELL_HEIGHT_PX));
  const maxCells = cols * rows;
  const cellX = new Float32Array(maxCells);
  const cellY = new Float32Array(maxCells);
  const cellDiag = new Float32Array(maxCells);
  const cellSeed = new Uint8Array(maxCells);

  let count = 0;
  for (let row = 0; row < rows; row += 1) {
    const v = rows > 1 ? row / (rows - 1) : 0;
    const py = row * CELL_HEIGHT_PX + CELL_HEIGHT_PX * 0.5;
    for (let col = 0; col < cols; col += 1) {
      const hash = cellHash(col, row);
      // Sparse occupancy (~50%) keeps the sweep airy and unobtrusive.
      if (hash > 128) continue;
      const u = cols > 1 ? col / (cols - 1) : 0;
      const jitter = (hash / 255 - 0.5) * 0.022;
      cellX[count] = col * CELL_WIDTH_PX + CELL_WIDTH_PX * 0.5;
      cellY[count] = py;
      cellDiag[count] = clamp01(u * 0.56 + v * 0.44 + jitter);
      cellSeed[count] = hash;
      count += 1;
    }
  }

  return { width, height, dpr, count, cellX, cellY, cellDiag, cellSeed };
}

/**
 * Subtle, non-blocking diagonal ASCII light-pass that sweeps top-left to
 * bottom-right once the window is actually revealed and visible.
 */
export function StartupAsciiReveal({ revealReady }: { revealReady?: Promise<void> }) {
  const [active, setActive] = useState(() => !prefersReducedMotion());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active) return;
    if (prefersReducedMotion()) {
      setActive(false);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      setActive(false);
      return;
    }

    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d', { alpha: true });
    } catch {
      ctx = null;
    }
    if (!ctx) {
      setActive(false);
      return;
    }

    let disposed = false;
    let rafId = 0;
    let safetyTimer: ReturnType<typeof setTimeout> | null = null;
    let readyFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let startedAt: number | null = null;
    let grid: GlyphGrid | null = null;

    // Precomputed per-band fill styles so the RAF loop allocates zero strings.
    let accent = DEFAULT_ACCENT;
    let crestRgb = mixHighlight(DEFAULT_ACCENT, 0.2);
    let bandStyles: readonly [string, string, string, string] = [
      'rgba(226, 232, 240, 0.34)',
      'rgba(226, 232, 240, 0.19)',
      'rgba(226, 232, 240, 0.10)',
      'rgba(226, 232, 240, 0.045)',
    ];
    let sheenPeakAlpha = 0.075;

    const refreshPalette = () => {
      const next = readAccentState();
      accent = next.rgb;
      crestRgb = mixHighlight(accent, 0.2);
      const g = next.glowFactor;
      sheenPeakAlpha = 0.075 * g;
      bandStyles = [
        `rgba(${crestRgb.r}, ${crestRgb.g}, ${crestRgb.b}, ${(0.34 * g).toFixed(3)})`,
        `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${(0.19 * g).toFixed(3)})`,
        `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${(0.1 * g).toFixed(3)})`,
        `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${(0.045 * g).toFixed(3)})`,
      ];
    };

    const syncGeometry = () => {
      const width = Math.max(1, window.innerWidth);
      const height = Math.max(1, window.innerHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

      if (grid && grid.width === width && grid.height === height && grid.dpr === dpr) return;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      grid = buildGrid(width, height, dpr);
    };

    const cleanup = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (safetyTimer !== null) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
      if (readyFallbackTimer !== null) {
        clearTimeout(readyFallbackTimer);
        readyFallbackTimer = null;
      }
      window.removeEventListener('resize', syncGeometry);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      canvas.width = 0;
      canvas.height = 0;
    };

    const finish = () => {
      if (disposed) return;
      disposed = true;
      cleanup();
      setActive(false);
    };

    const renderFrame = (now: number) => {
      if (disposed || !grid) return;

      if (startedAt === null) startedAt = now;
      const t = clamp01((now - startedAt) / SWEEP_DURATION_MS);
      const eased = 1 - (1 - t) ** 2.55;
      const front = -0.02 + eased * (1.04 + TRAIL_BAND_WIDTH);
      const stepBucket = Math.floor((now - startedAt) / GLYPH_STEP_MS);

      const { width, height, dpr, count, cellX, cellY, cellDiag, cellSeed } = grid;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // Gossamer diagonal accent sheen along the active ribbon (never blocks UI legibility).
      const fadeEnvelope = t < 0.12 ? t / 0.12 : t > 0.78 ? (1 - t) / 0.22 : 1;
      const sheenAlpha = sheenPeakAlpha * clamp01(fadeEnvelope);
      if (sheenAlpha > 0.002) {
        const grad = ctx.createLinearGradient(0, 0, width, height);
        const tailStop = clamp01(front - TRAIL_BAND_WIDTH);
        const crestStop = clamp01(front - CREST_WIDTH * 0.5);
        const headStop = clamp01(front + 0.03);
        grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
        if (tailStop > 0 && tailStop < 1) {
          grad.addColorStop(tailStop, 'rgba(0, 0, 0, 0)');
        }
        if (crestStop > 0 && crestStop < 1) {
          grad.addColorStop(
            crestStop,
            `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${sheenAlpha.toFixed(4)})`,
          );
        }
        if (headStop > 0 && headStop < 1) {
          grad.addColorStop(headStop, 'rgba(0, 0, 0, 0)');
        }
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
      }

      // Draw sparse micro-glyphs in 4 precomputed opacity bands (minimal fillStyle switches).
      ctx.font = '400 11px ui-monospace, "Cascadia Mono", "JetBrains Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      let currentBand = -1;
      for (let i = 0; i < count; i += 1) {
        const delta = front - cellDiag[i]!;
        if (delta < 0 || delta >= TRAIL_BAND_WIDTH) continue;

        let band: number;
        let glyph: string;
        const seed = cellSeed[i]! + stepBucket;
        if (delta < CREST_WIDTH) {
          band = 0;
          glyph = CREST_GLYPHS[seed % CREST_GLYPHS.length]!;
        } else {
          const trailRatio = (delta - CREST_WIDTH) / (TRAIL_BAND_WIDTH - CREST_WIDTH);
          band = trailRatio < 0.34 ? 1 : trailRatio < 0.68 ? 2 : 3;
          glyph = WAKE_GLYPHS[seed % WAKE_GLYPHS.length]!;
        }

        if (band !== currentBand) {
          ctx.fillStyle = bandStyles[band]!;
          currentBand = band;
        }
        ctx.fillText(glyph, cellX[i]!, cellY[i]!);
      }

      if (t >= 1) {
        finish();
        return;
      }

      rafId = requestAnimationFrame(renderFrame);
    };

    const beginSweep = () => {
      if (disposed || rafId || document.visibilityState === 'hidden') return;
      if (readyFallbackTimer !== null) {
        clearTimeout(readyFallbackTimer);
        readyFallbackTimer = null;
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      refreshPalette();
      syncGeometry();
      window.addEventListener('resize', syncGeometry);
      // Arm the safety deadline only once the reveal has actually started.
      safetyTimer = setTimeout(finish, SAFETY_TIMEOUT_MS);
      rafId = requestAnimationFrame(renderFrame);
    };

    let revealed = false;
    const armVisibleFallback = () => {
      if (disposed || revealed || rafId || readyFallbackTimer !== null) return;
      if (document.visibilityState === 'hidden') return;
      // If native fallback reveals the window before IPC replies, bound the wait cleanly.
      readyFallbackTimer = setTimeout(() => {
        readyFallbackTimer = null;
        if (disposed || document.visibilityState === 'hidden') return;
        revealed = true;
        beginSweep();
      }, REVEAL_READY_FALLBACK_MS);
    };

    const tryStart = () => {
      if (disposed || document.visibilityState === 'hidden') return;
      if (!revealed) {
        armVisibleFallback();
        return;
      }
      beginSweep();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (readyFallbackTimer !== null) {
          clearTimeout(readyFallbackTimer);
          readyFallbackTimer = null;
        }
        return;
      }
      tryStart();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    armVisibleFallback();
    void (revealReady ?? Promise.resolve()).finally(() => {
      revealed = true;
      tryStart();
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, [active, revealReady]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden='true'
      data-startup-ascii-reveal='true'
      className='pointer-events-none fixed inset-0 z-[120] select-none motion-reduce:hidden'
    />
  );
}
