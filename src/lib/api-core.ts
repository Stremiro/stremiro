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

export function getListErrorMessage(error: unknown): string | undefined {
  switch (getErrorKind(error)) {
    case 'list_name_required':
    case 'list_not_found':
    case 'too_many_lists':
    case 'list_full':
    case 'invalid_rules':
    case 'smart_list_read_only':
      return getErrorMessage(error);
    default:
      return undefined;
  }
}

export function getWatchStatusErrorMessage(error: unknown): string | undefined {
  switch (getErrorKind(error)) {
    case 'invalid_item':
    case 'invalid_status':
    case 'status_capacity':
    case 'library_capacity':
      return getErrorMessage(error);
    default:
      return undefined;
  }
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
