import type { CSSProperties, ImgHTMLAttributes } from 'react';
import { hideBrokenImage } from '@/lib/utils';

interface RemoteImageProps {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  /** Omitted where the artwork must paint immediately (drag overlays). */
  loading?: ImgHTMLAttributes<HTMLImageElement>['loading'];
  fetchPriority?: ImgHTMLAttributes<HTMLImageElement>['fetchPriority'];
  onLoad?: ImgHTMLAttributes<HTMLImageElement>['onLoad'];
  /** Broken artwork hides by default; `null` leaves the element as-is, or pass a handler for a custom fallback. */
  onError?: ImgHTMLAttributes<HTMLImageElement>['onError'] | null;
}

// Shared remote-artwork chrome: async decode, no referrer/drag ghost, hidden element over torn-image glyph.
export function RemoteImage({
  src,
  alt,
  className,
  style,
  loading,
  fetchPriority,
  onLoad,
  onError = hideBrokenImage,
}: RemoteImageProps) {
  return (
    // A changed URL must not inherit the previous image's hidden fallback.
    <img
      key={src}
      src={src}
      alt={alt}
      className={className}
      style={style}
      loading={loading}
      fetchPriority={fetchPriority}
      decoding='async'
      referrerPolicy='no-referrer'
      draggable={false}
      onLoad={onLoad}
      onError={onError ?? undefined}
    />
  );
}
