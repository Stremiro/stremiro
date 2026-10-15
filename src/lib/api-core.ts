import { invoke } from '@tauri-apps/api/core';
import { isTauriDesktopRuntime } from '@/lib/app-updater';

const isDev = import.meta.env.DEV;

export type InvokeApi = <T>(command: string, args?: object) => Promise<T>;

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const anyErr = error as Record<string, unknown>;
    if (typeof anyErr.message === 'string' && anyErr.message) return anyErr.message;
    if (typeof anyErr.error === 'string' && anyErr.error) return anyErr.error;
    if (typeof anyErr.err === 'string' && anyErr.err) return anyErr.err;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

// Exact Rust list validation messages that are safe to show; anything else stays generic.
const USER_FACING_LIST_ERROR =
  /^(?:List name is required\.|List not found|Too many lists\. Maximum is \d+\.|List is full\. Maximum is \d+ items\.|A custom list cannot exceed \d+ items)$/;

export function getListErrorMessage(error: unknown): string | undefined {
  const message = getErrorMessage(error);
  return USER_FACING_LIST_ERROR.test(message) ? message : undefined;
}

/** `kind` tag of a structured Rust command error (carried as the Error's `cause`). */
export function getErrorKind(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : error;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const kind = (cause as Record<string, unknown>).kind;
  return typeof kind === 'string' ? kind : undefined;
}

export async function safeInvoke<T>(command: string, args?: object): Promise<T> {
  // Tauri #[command] maps Rust params to camelCase JS keys (media_type→mediaType,
  // type_→type); nested struct payloads follow their own serde renames.
  try {
    if (isTauriDesktopRuntime()) {
      return await invoke<T>(command, args as Record<string, unknown> | undefined);
    }

    // DEV gate keeps the browser-preview mock fork out of production builds.
    if (isDev) {
      console.warn(`[Preview] invoking ${command}`);
      const { handlePreviewInvoke } = await import('@/lib/api-preview-mocks');
      return await handlePreviewInvoke<T>(command, args as Record<string, unknown> | undefined);
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
