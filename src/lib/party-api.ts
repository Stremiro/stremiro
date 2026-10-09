import { invoke } from '@tauri-apps/api/core';
import type { CSSProperties } from 'react';
import type { PlayerRouteMediaType } from '@/lib/player-navigation';
import type { PlayerStreamRequest } from '@/lib/resolve-player-stream';

/** OS deep-link form of an invite; Rust owns the actual codec. */
export const PARTY_INVITE_PREFIX = 'stremiro://party/';

export interface PartyMedia {
  mediaType: PlayerRouteMediaType;
  mediaId: string;
  season: number | null;
  episode: number | null;
}

export function partyMediaKey(media: PartyMedia | null | undefined): string {
  return JSON.stringify(
    media ? [media.mediaType, media.mediaId, media.season, media.episode] : null,
  );
}

/** A local player sample; Rust clamps, fingerprints and validates it. */
export interface PartyLocalPlayback {
  media: PartyMedia;
  posMs: number;
  paused: boolean;
  rate: number;
  durMs: number;
  buffering: boolean;
}

export interface PartySharedPlayback {
  media: PartyMedia;
  paused: boolean;
  rate: number;
  /** The sharer's source is fingerprinted, so `matchStream` can look for it. */
  matchable: boolean;
}

export interface PartySnapshot {
  session: string;
  revision: number;
  active: boolean;
  creator: boolean;
  locked: boolean;
  syncing: boolean;
  members: PartyMember[];
  chat: { id: string; memberId: string; name: string; text: string }[];
  playback: PartySharedPlayback | null;
  playbackIsLocal: boolean;
  /** Member id behind the shared playback's latest control. */
  playbackBy: string | null;
  error: string | null;
}

export interface PartyMember {
  id: string;
  name: string;
  creator: boolean;
  you: boolean;
  buffering: boolean;
}

/** Deterministic letter-avatar tint per member id — rooms never exchange
    avatar URLs, so color is the only stable visual identity. */
export function partyMemberStyle(memberId: string): CSSProperties {
  let hash = 0;
  for (let index = 0; index < memberId.length; index++) {
    hash = (hash * 31 + memberId.charCodeAt(index)) % 360;
  }
  return { backgroundColor: `hsl(${hash} 38% 30%)` };
}

export type PartyNotice =
  | { kind: 'synced' }
  | { kind: 'paused'; by: string }
  | { kind: 'resumed'; by: string }
  | { kind: 'jumped'; by: string; toMs: number }
  | { kind: 'speedLimited' }
  | { kind: 'sourcesDiffer' };

export interface PartyCorrection {
  token: string;
  seekMs: number | null;
  paused: boolean | null;
  rate: number | null;
  notices: PartyNotice[];
}

export const partyApi = {
  snapshot: () => invoke<PartySnapshot>('party_snapshot'),
  create: (name: string) => invoke<PartySnapshot>('party_create', { name }),
  join: (name: string, invite: string) => invoke<PartySnapshot>('party_join', { name, invite }),
  inspect: (invite: string) => invoke<void>('party_inspect_invite', { invite }),
  invite: (sessionId: string) => invoke<string>('party_invite', { sessionId }),
  leave: (sessionId: string) => invoke<void>('party_leave', { sessionId }),
  chat: (sessionId: string, text: string) => invoke<void>('party_send_chat', { sessionId, text }),
  name: (sessionId: string, name: string) =>
    invoke<void>('party_set_display_name', { sessionId, name }),
  lock: (sessionId: string, locked: boolean) =>
    invoke<void>('party_set_lock', { sessionId, locked }),
  /** Resolves to the room's live position (ms) for launching the shared media. */
  follow: (sessionId: string, share: boolean) =>
    invoke<number | null>('party_follow', { sessionId, share }),
  matchStream: (sessionId: string, request: PlayerStreamRequest) =>
    invoke<string | null>('party_match_stream', { sessionId, request }),
  report: (
    sessionId: string,
    playback: PartyLocalPlayback,
    streamKey: string | null,
    token: string,
  ) =>
    invoke<PartyCorrection>('party_report_playback', {
      sessionId,
      report: { playback, streamKey, token },
    }),
};
