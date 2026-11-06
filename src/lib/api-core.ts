import { invoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';
import { isTauriDesktopRuntime } from '@/lib/app-updater';
import { getErrorMessage } from '@/lib/utils';

export { getErrorMessage } from '@/lib/utils';

const isDev = import.meta.env.DEV;

export type InvokeApi = <T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
) => Promise<T>;

function getKindErrorMessage(error: unknown, kinds: readonly string[]): string | undefined {
  return kinds.includes(getErrorKind(error) ?? '') ? getErrorMessage(error) : undefined;
}

export function getListErrorMessage(error: unknown): string | undefined {
  return getKindErrorMessage(error, [
    'list_name_required',
    'list_not_found',
    'too_many_lists',
    'list_full',
  ]);
}

export function getWatchStatusErrorMessage(error: unknown): string | undefined {
  return getKindErrorMessage(error, [
    'invalid_item',
    'invalid_status',
    'status_capacity',
    'library_capacity',
  ]);
}

/** Rust `AddonResourceError`: no enabled addon serves the request, so Retry cannot help. */
export function isNoCapableAddonError(error: unknown): boolean {
  return getErrorKind(error) === 'no_capable_addon';
}

export function getBackupImportErrorMessage(error: unknown): string {
  switch (getErrorKind(error)) {
    case 'invalid_backup':
      return 'This file is not a valid Stremiro backup.';
    case 'unsupported_version':
      return 'This backup was created by a newer or unsupported version.';
    case 'too_large':
      return 'This file is too large to import.';
    case 'capacity_exceeded':
      return `${getErrorMessage(error)} Remove some items first, then try again.`;
    default:
      return getErrorMessage(error);
  }
}

/** `kind` tag of a structured Rust command error (carried as the Error's `cause`). */
export function getErrorKind(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : error;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const kind = (cause as Record<string, unknown>).kind;
  return typeof kind === 'string' ? kind : undefined;
}

export async function safeInvoke<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  // Tauri #[command] maps Rust params to camelCase JS keys (media_type→mediaType,
  // type_→type); nested struct payloads follow their own serde renames.
  try {
    if (isTauriDesktopRuntime()) {
      return await invoke<T>(command, args, options);
    }

    // DEV gate keeps the browser-preview mock fork out of production builds.
    if (isDev) {
      if (args instanceof Uint8Array || args instanceof ArrayBuffer || Array.isArray(args)) {
        throw new Error(`Command "${command}" requires the Tauri desktop runtime.`);
      }
      console.warn(`[Preview] invoking ${command}`);
      const { handlePreviewInvoke } = await import('@/lib/api-preview-mocks');
      return await handlePreviewInvoke<T>(command, args);
    }
  } catch (error) {
    if (isDev) console.error(`Raw invoke error for ${command}:`, error);
    const message = getErrorMessage(error);
    if (isDev) console.error(`Processed error message for ${command}:`, message);
    throw new Error(message || 'Unknown error (empty message)', { cause: error });
  }

  // Outside the try — not an invoke failure, must not be dev-logged/re-wrapped as one.
  throw new Error(`Command "${command}" requires the Tauri desktop runtime.`);
}
