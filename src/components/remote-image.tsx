import type { CSSProperties, ImgHTMLAttributes } from 'react';
import { cn, hideBrokenImage } from '@/lib/utils';

interface RemoteImageProps {
  src: string;
  fallbackSrc?: string;
  fadeIn?: boolean;
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

function showCachedImage(image: HTMLImageElement | null) {
  if (image?.complete && image.naturalWidth > 0) image.dataset.loaded = 'cached';
}

// Shared remote-artwork chrome: async decode, no referrer/drag ghost, hidden element over torn-image glyph.
export function RemoteImage({
  src,
  fallbackSrc,
  fadeIn = false,
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
      key={`${src}\n${fallbackSrc ?? ''}`}
      ref={fadeIn ? showCachedImage : undefined}
      src={src}
      alt={alt}
      className={
        fadeIn
          ? cn(
              className,
              'opacity-0 transition-opacity duration-300 data-[loaded=true]:opacity-100 data-[loaded=cached]:opacity-100 data-[loaded=cached]:transition-none',
            )
          : className
      }
      style={style}
      loading={loading}
      fetchPriority={fetchPriority}
      decoding='async'
      referrerPolicy='no-referrer'
      draggable={false}
      onLoad={
        fadeIn
          ? (event) => {
              const image = event.currentTarget;
              const loadedSrc = image.currentSrc;
              void image
                .decode()
                .catch(() => {})
                .then(() => {
                  if (
                    image.isConnected &&
                    image.currentSrc === loadedSrc &&
                    image.naturalWidth > 0
                  ) {
                    image.dataset.loaded ??= 'true';
                  }
                });
              onLoad?.(event);
            }
          : onLoad
      }
      onError={(event) => {
        const image = event.currentTarget;
        if (fallbackSrc && fallbackSrc !== src && !image.dataset.fallback) {
          image.dataset.fallback = 'true';
          delete image.dataset.loaded;
          image.src = fallbackSrc;
          return;
        }
        onError?.(event);
      }}
    />
  );
}
