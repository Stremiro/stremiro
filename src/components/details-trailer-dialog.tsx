import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

interface DetailsTrailerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trailerUrl: string | null;
  title: string;
}

export function DetailsTrailerDialog({
  open,
  onOpenChange,
  trailerUrl,
  title,
}: DetailsTrailerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='w-[calc(100vw-2rem)] max-w-[min(64rem,calc((100dvh-4rem)*16/9))] overflow-hidden rounded-lg border-white/10 bg-black p-0'>
        <DialogTitle className='sr-only'>{title} — Trailer</DialogTitle>
        <DialogDescription className='sr-only'>Trailer video for {title}.</DialogDescription>
        {trailerUrl && (
          <div className='aspect-video w-full'>
            {/* eslint-disable react/iframe-missing-sandbox -- the embed needs
                scripts+same-origin to function; the sandbox still bounds
                top-level navigation, forms, and downloads. */}
            <iframe
              className='block h-full w-full border-0'
              src={trailerUrl}
              title={`${title} — Trailer`}
              sandbox='allow-scripts allow-same-origin allow-presentation allow-popups'
              allow='accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture'
              referrerPolicy='strict-origin-when-cross-origin'
              allowFullScreen
            />
            {/* eslint-enable react/iframe-missing-sandbox */}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
