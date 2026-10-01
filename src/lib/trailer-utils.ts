const YOUTUBE_EMBED_BASE_URL = 'https://www.youtube-nocookie.com/embed';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

export const YOUTUBE_PLAYER_STATE = {
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
} as const;

type YouTubePlayerCommand = 'addEventListener' | 'mute' | 'pauseVideo' | 'playVideo' | 'seekTo';

const YOUTUBE_PLAYER_ORIGINS = new Set([
  'https://www.youtube.com',
  'https://youtube.com',
  'https://www.youtube-nocookie.com',
  'https://youtube-nocookie.com',
]);

interface YouTubeEmbedOptions {
  autoplay?: boolean;
  mute?: boolean;
  controls?: boolean;
  playsInline?: boolean;
  rel?: boolean;
  origin?: string;
  // Hover-preview mode: hide keyboard shortcuts, fullscreen, and annotations,
  // and enable the JS API so the caller can wait for PLAYING before revealing
  // the iframe. YouTube always draws title/channel chrome before play, on
  // pause, and on end — there is no supported parameter that removes it.
  chromeless?: boolean;
}

function isValidYouTubeVideoId(candidate: string | null | undefined): candidate is string {
  return typeof candidate === 'string' && /^[A-Za-z0-9_-]{11}$/.test(candidate);
}

export function extractYouTubeVideoId(rawUrl?: string | null): string | null {
  const candidate = rawUrl?.trim();
  if (!candidate) return null;

  if (isValidYouTubeVideoId(candidate)) {
    return candidate;
  }

  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();

    if (!YOUTUBE_HOSTS.has(host)) {
      return null;
    }

    if (host === 'youtu.be' || host === 'www.youtu.be') {
      const pathId = url.pathname.split('/').find(Boolean);
      return isValidYouTubeVideoId(pathId) ? pathId : null;
    }

    const pathSegments = url.pathname.split('/').filter(Boolean);
    const trailingPathId = pathSegments[pathSegments.length - 1];
    const directId =
      url.searchParams.get('v') ||
      url.searchParams.get('vi') ||
      url.pathname.match(/\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})(?:\b|\/|$)/)?.[1] ||
      trailingPathId;

    return isValidYouTubeVideoId(directId) ? directId : null;
  } catch {
    const fallbackMatch = String(candidate).match(
      /(?:v=|vi=|embed\/|shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/i,
    );
    return isValidYouTubeVideoId(fallbackMatch?.[1]) ? fallbackMatch[1] : null;
  }
}

export function buildYouTubeEmbedUrl(
  videoId: string,
  {
    autoplay = false,
    mute = false,
    controls = true,
    playsInline = true,
    rel = false,
    origin,
    chromeless = false,
  }: YouTubeEmbedOptions = {},
): string {
  const params = new URLSearchParams({
    autoplay: autoplay ? '1' : '0',
    controls: controls ? '1' : '0',
    mute: mute ? '1' : '0',
    playsinline: playsInline ? '1' : '0',
    rel: rel ? '1' : '0',
  });

  if (chromeless) {
    params.set('disablekb', '1');
    params.set('fs', '0');
    params.set('iv_load_policy', '3');
    params.set('enablejsapi', '1');
  }

  if (origin) {
    params.set('origin', origin);
  }

  return `${YOUTUBE_EMBED_BASE_URL}/${videoId}?${params.toString()}`;
}

const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

function postYouTubePlayerMessage(
  iframe: HTMLIFrameElement,
  payload: Record<string, unknown>,
): void {
  // Least-privilege target: embeds are always built from
  // YOUTUBE_EMBED_BASE_URL, so a wildcard would also message a swapped
  // iframe src. Payloads are fixed-shape player commands only.
  iframe.contentWindow?.postMessage(
    JSON.stringify({ channel: 'widget', ...payload }),
    YOUTUBE_EMBED_ORIGIN,
  );
}

export function postYouTubeListening(iframe: HTMLIFrameElement): void {
  postYouTubePlayerMessage(iframe, { event: 'listening', id: 1 });
}

export function postYouTubeCommand(
  iframe: HTMLIFrameElement,
  func: YouTubePlayerCommand,
  args: unknown[] = [],
): void {
  postYouTubePlayerMessage(iframe, { event: 'command', func, args });
}

export function parseYouTubeMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }

  return null;
}

function readPlayerState(info: unknown): number | null {
  if (typeof info === 'number' && Number.isFinite(info)) {
    return info;
  }

  if (info && typeof info === 'object' && !Array.isArray(info) && 'playerState' in info) {
    const playerState = (info as { playerState: unknown }).playerState;
    return typeof playerState === 'number' && Number.isFinite(playerState) ? playerState : null;
  }

  return null;
}

export function isYouTubeReadyEvent(payload: Record<string, unknown> | null): boolean {
  return payload?.event === 'onReady';
}

export function parseYouTubePlayerState(payload: Record<string, unknown> | null): number | null {
  if (!payload) {
    return null;
  }

  const event = payload.event;
  if (event !== 'onStateChange' && event !== 'infoDelivery' && event !== 'initialDelivery') {
    return null;
  }

  return readPlayerState(payload.info);
}

export function isYouTubePlayerOrigin(origin: string): boolean {
  return YOUTUBE_PLAYER_ORIGINS.has(origin);
}

export function resolveTrailerEmbedUrl(
  rawUrl?: string | null,
  options?: YouTubeEmbedOptions,
): string | null {
  const videoId = extractYouTubeVideoId(rawUrl);
  return videoId ? buildYouTubeEmbedUrl(videoId, options) : null;
}
