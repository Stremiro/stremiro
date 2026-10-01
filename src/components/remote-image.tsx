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
  /** Broken artwork hides by default; pass a handler where the caller
      renders its own fallback, or `null` to leave the element as-is. */
  onError?: ImgHTMLAttributes<HTMLImageElement>['onError'] | null;
}

// Shared chrome for remote artwork: async decode, no referrer leak, no
// native drag ghost, and a hidden element instead of the browser's
// torn-image glyph.
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
    <img
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
