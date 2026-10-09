import { Component, useLayoutEffect, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { useBrowseHotkeys } from '@/hooks/use-browse-hotkeys';
import { useProfileAccent } from '@/hooks/use-local-profile';
import { navigateApp } from '@/lib/navigation';
import { clamp, getAccentTextColor, hexToRgbTriplet } from '@/lib/utils';
import { DesktopTitlebar } from './desktop-titlebar';
import { Sidebar } from './sidebar';

// Soft neutral rendered in place of the accent on surfaces the user opted out.
const NEUTRAL_ACCENT = '#d4d4d8';

// A route render crash must not unmount the tree above it — PlayerHost and
// the docked mini player live outside the outlet. Contain the failure to
// the page; navigation resets the boundary via the location key.
class RouteErrorBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { hasError: boolean; resetKey: string }
> {
  state = { hasError: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { hasError: boolean; resetKey: string },
  ) {
    if (props.resetKey === state.resetKey) return null;
    return { resetKey: props.resetKey, hasError: false };
  }

  componentDidCatch(error: unknown) {
    if (import.meta.env.DEV) console.error('[route] render error', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          role='alert'
          className='flex min-h-[60vh] w-full flex-col items-center justify-center gap-4 px-6 text-center'
        >
          <div className='flex flex-col items-center gap-1.5'>
            <p className='text-lg font-semibold text-white'>This page couldn't be displayed.</p>
            <p className='text-sm text-white/50'>
              Playback and the rest of the app are unaffected.
            </p>
          </div>
          <div className='flex items-center gap-3'>
            <Button onClick={() => this.setState({ hasError: false })}>Try again</Button>
            <Button variant='outline' onClick={() => navigateApp('/')}>
              Go home
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function RouteOutlet() {
  const { key } = useLocation();
  return (
    <RouteErrorBoundary resetKey={key}>
      <Outlet />
    </RouteErrorBoundary>
  );
}

export function Layout() {
  const { accentColor: accent, accentIntensity, accentTargets } = useProfileAccent();
  // 0 hides the ambient tint entirely; 100 is the full premium-subtle glow.
  const glowScale = clamp(accentIntensity, 0, 100) / 100;

  // Browse-page keys: `/`/`Ctrl+K` to search, Esc/Backspace/Alt+← for back.
  // Subscription-free (window listener + bound navigate), so Layout's render
  // cost is unchanged. Player routes never mount Layout — its richer hotkey
  // map owns the keyboard there.
  useBrowseHotkeys();

  // Layout effect: the accent vars must be on <html> before first paint — a
  // passive effect would flash the white fallback for one frame on launch.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--app-accent', accent);
    root.style.setProperty('--app-accent-rgb', hexToRgbTriplet(accent));
    root.style.setProperty('--on-app-accent', getAccentTextColor(accent));
    root.style.setProperty('--app-glow', String(glowScale));
    const targets: Array<[key: string, enabled: boolean]> = [
      ['nav', accentTargets.navigation],
      ['act', accentTargets.actions],
      ['prog', accentTargets.progress],
      ['art', accentTargets.artwork],
    ];
    for (const [key, enabled] of targets) {
      const resolved = enabled ? accent : NEUTRAL_ACCENT;
      root.style.setProperty(`--accent-${key}`, resolved);
      root.style.setProperty(`--accent-${key}-rgb`, hexToRgbTriplet(resolved));
      root.style.setProperty(`--on-accent-${key}`, getAccentTextColor(resolved));
    }
  }, [accent, accentTargets, glowScale]);

  return (
    <>
      <DesktopTitlebar />
      <div data-mini-mask className='fixed inset-0 bg-black -z-10' />
      {/* App-wide ambient tint driven by the profile accent color and glow scale.
          Pure radial gradients with no blur filter: blur on viewport-sized layers
          gets clipped by overflow-hidden and quantizes into visible rings on
          WebView2. Mid stops smooth the falloff into 8-bit panels. Alpha rides
          var(--app-glow) so the settings slider previews live — always mounted,
          transparent at 0. */}
      <div aria-hidden='true' data-mini-mask className='pointer-events-none fixed inset-0 z-0'>
        <div
          className='absolute inset-0'
          style={{
            background: `radial-gradient(55% 42% at 12% 0%, rgb(var(--app-accent-rgb) / calc(0.09 * var(--app-glow))) 0%, rgb(var(--app-accent-rgb) / calc(0.045 * var(--app-glow))) 42%, transparent 70%), radial-gradient(36% 28% at 94% 112%, rgb(var(--app-accent-rgb) / calc(0.04 * var(--app-glow))) 0%, rgb(var(--app-accent-rgb) / calc(0.02 * var(--app-glow))) 45%, transparent 72%)`,
          }}
        />
        {/* Subtle dot halftone confined to the frame edges breaks up any
          remaining banding without adding a fullscreen filter pass. Both
          fields end off-screen before content like the calendar grid,
          whose translucent cells would otherwise let the dots read as an
          overlay on the dates. Each field is its own element so the
          ambient-activity cue can drift them independently — the top-left
          shimmers while the bottom-right marches like a loading bar. */}
        <div
          // Slack past the viewport lets the composited drift translate land
          // without exposing an unpainted edge (see ambient-dots keyframes).
          className='ambient-dots-tl absolute -inset-2'
          style={{
            backgroundImage: `radial-gradient(rgb(var(--app-accent-rgb) / calc(0.008 * var(--app-glow))) 1px, transparent 1.9px)`,
            backgroundSize: '8px 8px',
            maskImage: 'radial-gradient(38% 28% at 8% 0%, black 0%, transparent 55%)',
            WebkitMaskImage: 'radial-gradient(38% 28% at 8% 0%, black 0%, transparent 55%)',
          }}
        />
        <div
          className='ambient-dots-br absolute inset-y-0 -inset-x-7'
          style={{
            backgroundImage: `radial-gradient(rgb(var(--app-accent-rgb) / calc(0.008 * var(--app-glow))) 1px, transparent 1.9px)`,
            backgroundSize: '8px 8px',
            maskImage: 'radial-gradient(18% 12% at 99% 121%, black 0%, transparent 40%)',
            WebkitMaskImage: 'radial-gradient(18% 12% at 99% 121%, black 0%, transparent 40%)',
          }}
        />
      </div>
      {/* Dithering grain behind page content with the ambient: it dithers the gradients
          shining through translucent panels without ever sitting over text. */}
      <div
        aria-hidden='true'
        data-mini-mask
        className='grain-overlay pointer-events-none fixed inset-0 z-0 opacity-[0.05]'
      />
      <div className='relative z-10 min-h-screen text-foreground font-sans antialiased'>
        <Sidebar className='fixed left-0 top-0 z-50 flex' />
        <div
          data-mini-mask
          className='relative flex min-h-[calc(100vh-2rem)] min-w-0 flex-col pt-8 overflow-x-clip'
        >
          {/* Route pushes land keyboard focus here (see RouteScrollManager). */}
          <main id='app-main' tabIndex={-1} className='flex-1'>
            <div className='min-h-full'>
              <RouteOutlet />
            </div>
          </main>
        </div>
      </div>
    </>
  );
}
