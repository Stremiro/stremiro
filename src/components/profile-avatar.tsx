import { Camera, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { type ChangeEvent, type CSSProperties, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { LocalProfile, LocalProfileUpdate } from '@/hooks/use-local-profile';
import { getErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

const AVATAR_SIZE_PX = 256;
const AVATAR_WEBP_QUALITY = 0.85;
const AVATAR_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp';
const MENU_ITEM_CLASS = 'cursor-pointer gap-2 text-[12.5px]';

// Center-crop to a square and re-encode small: the result rides the
// preferences blob, so a raw multi-MB photo must never reach IPC.
async function encodeAvatar(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE_PX;
    canvas.height = AVATAR_SIZE_PX;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image processing is unavailable');
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIZE_PX,
      AVATAR_SIZE_PX,
    );
    return canvas.toDataURL('image/webp', AVATAR_WEBP_QUALITY);
  } finally {
    bitmap.close();
  }
}

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
  return (
    <Avatar className={className}>
      {avatar ? <AvatarImage src={avatar} alt='' draggable={false} /> : null}
      <AvatarFallback className={fallbackClassName} style={fallbackStyle}>
        {name.charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/** Profile-header avatar: click to upload, or change/remove once one is set. */
export function ProfileAvatarEditor({
  onUpdate,
  profile,
}: {
  onUpdate: (updates: LocalProfileUpdate) => Promise<void>;
  profile: LocalProfile;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const { accentColor, avatar, username } = profile;

  const openPicker = () => inputRef.current?.click();

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so re-picking the same file still fires `change`.
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Choose an image file');
      return;
    }
    if (file.size > AVATAR_SOURCE_MAX_BYTES) {
      toast.error('That image is over 25 MB');
      return;
    }

    setIsProcessing(true);
    try {
      const encoded = await encodeAvatar(file).catch(() => {
        throw new Error("Couldn't read that image — try a PNG, JPEG, or WebP");
      });
      await onUpdate({ avatar: encoded });
      toast.success('Profile photo updated');
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRemove = () => {
    onUpdate({ avatar: undefined }).then(
      () => toast.success('Profile photo removed'),
      (error: unknown) => toast.error(getErrorMessage(error)),
    );
  };

  const trigger = (
    <button
      type='button'
      title={avatar ? 'Change photo' : 'Add a photo'}
      aria-label={avatar ? 'Change profile photo' : 'Add profile photo'}
      aria-busy={isProcessing}
      disabled={isProcessing}
      onClick={avatar ? undefined : openPicker}
      className='group/avatar relative shrink-0 rounded-full p-[2px] transition-all duration-700 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-black'
      style={{
        background: `linear-gradient(135deg, ${accentColor}80, ${accentColor}14 55%, transparent 80%)`,
      }}
    >
      <ProfileAvatar
        name={username}
        avatar={avatar}
        className='h-20 w-20 shadow-xl'
        fallbackClassName='text-2xl font-black transition-colors duration-300'
        fallbackStyle={{ backgroundColor: '#0a0a0b', color: accentColor }}
      />
      <span
        aria-hidden='true'
        className={cn(
          'absolute inset-[2px] flex items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity duration-200 group-hover/avatar:opacity-100 group-focus-visible/avatar:opacity-100',
          isProcessing && 'opacity-100',
        )}
      >
        {isProcessing ? (
          <Loader2 className='h-5 w-5 animate-spin' />
        ) : (
          <Camera className='h-5 w-5' />
        )}
      </span>
    </button>
  );

  return (
    <>
      {avatar ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent align='start' className='w-44'>
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
