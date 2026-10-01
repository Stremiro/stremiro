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

export async function safeInvoke<T>(command: string, args?: object): Promise<T> {
  // Tauri #[command] exposes Rust params to JS in camelCase by default
  // (Rust `media_type` <-> JS `mediaType`, Rust `type_` <-> JS `type`).
  // Keep every flat invoke key camelCase here; nested struct payloads follow
  // their own serde renames (usually camelCase too, e.g. SearchCatalogRequest).
  // `object` keeps structured payloads (e.g. PlaybackStreamOutcomeReport)
  // passable without per-site `as unknown as Record` erasure; the single
  // narrowing cast below is the only invoke-boundary cast.
  try {
    if (isTauriDesktopRuntime()) {
      return await invoke<T>(command, args as Record<string, unknown> | undefined);
    }

    // Browser preview is a dev-only workflow: gating on DEV keeps the
    // Rust-mirroring mock fork out of production builds entirely.
    if (isDev) {
      console.warn(`[Preview] invoking ${command}`);
      const { handlePreviewInvoke } = await import('@/lib/api-preview-mocks');
      return await handlePreviewInvoke<T>(command, args as Record<string, unknown> | undefined);
    }

    throw new Error(`Command "${command}" requires the Tauri desktop runtime.`);
  } catch (error) {
    if (isDev) console.error(`Raw invoke error for ${command}:`, error);
    const message = getErrorMessage(error);
    if (isDev) console.error(`Processed error message for ${command}:`, message);
    throw new Error(message || 'Unknown error (empty message)', { cause: error });
  }
}
