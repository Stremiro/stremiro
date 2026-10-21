import { Camera, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { type ChangeEvent, type CSSProperties, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { type LocalProfile, useProfileAvatarMutation } from '@/hooks/use-local-profile';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { getErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

const AVATAR_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';
const MENU_ITEM_CLASS = 'cursor-pointer gap-2 text-[12.5px]';

export function ProfileAvatar({
  avatar,
  className,
  fallbackClassName,
  fallbackStyle,
  name,
}: {
  avatar?: string;
  className?: string;
  fallbackClassName?: string;
  fallbackStyle?: CSSProperties;
  name: string;
}) {
  const [image, setImage] = useState<{ src: string; loaded: boolean } | null>(null);
  const status = avatar && image?.src === avatar ? (image.loaded ? 'loaded' : 'failed') : 'loading';
  return (
    <span
      className={cn('relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full', className)}
    >
      {status !== 'loaded' && (
        <span
          className={cn(
            'flex h-full w-full items-center justify-center rounded-full bg-muted',
            fallbackClassName,
          )}
          style={fallbackStyle}
        >
          {Array.from(name)[0]?.toUpperCase()}
        </span>
      )}
      {avatar && status !== 'failed' && (
        <img
          src={avatar}
          alt=''
          draggable={false}
          className='absolute inset-0 h-full w-full object-cover'
          onLoad={() => setImage({ src: avatar, loaded: true })}
          onError={() => setImage({ src: avatar, loaded: false })}
        />
      )}
    </span>
  );
}

/** Profile-header avatar: click to upload, or change/remove once one is set. */
export function ProfileAvatarEditor({ profile }: { profile: LocalProfile }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusIntentRef = useRef<HTMLElement | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const mountedRef = useMountedRef();
  const updateAvatar = useProfileAvatarMutation();
  const { accentColor, avatar, username } = profile;

  const restoreTriggerFocus = (event?: Event) => {
    const previous = focusIntentRef.current;
    if (!previous) return;
    if (!previous.isConnected && document.activeElement === document.body) {
      triggerRef.current?.focus({ preventScroll: true });
      focusIntentRef.current = triggerRef.current;
    } else if (document.activeElement !== previous) {
      focusIntentRef.current = null;
    }
    if (focusIntentRef.current) event?.preventDefault();
  };

  useLayoutEffect(() => {
    restoreTriggerFocus();
    if (!isProcessing) focusIntentRef.current = null;
  });

  const openPicker = () => {
    if (!isProcessing) inputRef.current?.click();
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so re-picking the same file still fires `change`.
    event.target.value = '';
    if (!file || isProcessing) return;
    if (file.size > AVATAR_SOURCE_MAX_BYTES) {
      toast.error('That image is over 25 MB');
      return;
    }

    setIsProcessing(true);
    focusIntentRef.current =
      document.activeElement === triggerRef.current ? triggerRef.current : null;
    await updateAvatar(file)
      .then(() => toast.success('Profile photo updated'))
      .catch((error: unknown) => toast.error(getErrorMessage(error)))
      .finally(() => {
        if (mountedRef.current) setIsProcessing(false);
      });
  };

  const handleRemove = () => {
    if (isProcessing) return;
    setIsProcessing(true);
    focusIntentRef.current =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
    updateAvatar(null)
      .then(
        () => toast.success('Profile photo removed'),
        (error: unknown) => toast.error(getErrorMessage(error)),
      )
      .finally(() => {
        if (mountedRef.current) setIsProcessing(false);
      });
  };

  const trigger = (
    <button
      ref={triggerRef}
      type='button'
      title={avatar ? 'Change photo' : 'Add a photo'}
      aria-label={avatar ? 'Change profile photo' : 'Add profile photo'}
      aria-busy={isProcessing}
      aria-disabled={isProcessing || undefined}
      onClick={avatar ? undefined : openPicker}
      className='group/avatar relative shrink-0 rounded-full p-[2px] transition-shadow duration-200 motion-reduce:transition-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-black aria-disabled:cursor-default'
      style={{
        background: `linear-gradient(135deg, ${accentColor}80, ${accentColor}14 55%, transparent 80%)`,
      }}
    >
      <ProfileAvatar
        name={username}
        avatar={avatar}
        className='h-20 w-20 shadow-xl'
        fallbackClassName='text-2xl font-black transition-colors duration-200 motion-reduce:transition-none'
        fallbackStyle={{ backgroundColor: '#0a0a0b', color: accentColor }}
      />
      <span
        aria-hidden='true'
        className={cn(
          'absolute inset-[2px] flex items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none group-hover/avatar:opacity-100 group-focus-visible/avatar:opacity-100',
          isProcessing && 'opacity-100',
        )}
      >
        {isProcessing ? (
          <Loader2 className='h-5 w-5 animate-spin motion-reduce:animate-none' />
        ) : (
          <Camera className='h-5 w-5' />
        )}
      </span>
      <span
        aria-hidden='true'
        className={cn(
          'pointer-events-none absolute bottom-0 right-0 flex h-6 w-6 items-center justify-center rounded-md border border-white/[0.12] bg-zinc-900 text-zinc-300 shadow-sm transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/avatar:opacity-0 group-focus-visible/avatar:opacity-0 motion-reduce:transition-none',
          isProcessing && 'opacity-0',
        )}
      >
        <Camera className='h-3 w-3' />
      </span>
    </button>
  );

  return (
    <>
      {avatar ? (
        <DropdownMenu
          open={menuOpen}
          onOpenChange={(open) => {
            if (!isProcessing || !open) setMenuOpen(open);
          }}
        >
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent
            align='start'
            className='w-44'
            onCloseAutoFocus={restoreTriggerFocus}
          >
            <DropdownMenuItem onSelect={openPicker} className={MENU_ITEM_CLASS}>
              <ImagePlus className='h-3.5 w-3.5' />
              Change photo…
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={handleRemove}
              className={cn(MENU_ITEM_CLASS, 'text-red-300 focus:text-red-200')}
            >
              <Trash2 className='h-3.5 w-3.5' />
              Remove photo
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        trigger
      )}
      <input
        ref={inputRef}
        type='file'
        accept={AVATAR_ACCEPT}
        tabIndex={-1}
        aria-hidden='true'
        className='hidden'
        onChange={(event) => void handleFile(event)}
      />
    </>
  );
}
