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
      <DialogContent className='max-w-5xl p-0 overflow-hidden bg-black border-zinc-800'>
        <DialogTitle className='sr-only'>{title} — Trailer</DialogTitle>
        <DialogDescription className='sr-only'>Trailer video for {title}.</DialogDescription>
        {trailerUrl && (
          <div className='aspect-video w-full'>
            {/* eslint-disable react/iframe-missing-sandbox -- the embed needs
                scripts+same-origin to function; the sandbox still bounds
                top-level navigation, forms, and downloads. */}
            <iframe
              width='100%'
              height='100%'
              src={trailerUrl}
              title='Trailer'
              frameBorder='0'
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
