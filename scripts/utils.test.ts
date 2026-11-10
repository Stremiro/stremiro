import { expect, mock, test } from 'bun:test';
import type { KeyboardEvent } from 'react';
import type { HistoryPlaybackPlan, MediaItem, UserList } from '../src/lib/api';
import { handlePreviewInvoke as previewInvoke } from '../src/lib/api-preview-mocks';
import { handleRovingGroupKeyDown } from '../src/lib/dom';
import { resolvePlayerRouteMediaType } from '../src/lib/player-navigation';
import { formatRuntime, mediaTypeLabel, orderByIds } from '../src/lib/utils';

test('orderByIds preserves row identity and duplicate, unknown, and omitted ID behavior', () => {
  const first = { id: 'a', title: 'Original' };
  const last = { id: 'a', title: 'Updated' };
  const second = { id: 'b', title: 'Second' };
  const third = { id: 'c', title: 'Third' };
  const source = [first, second, last, third];

  expect(orderByIds(source)).toBe(source);
  expect(orderByIds(source, null)).toBe(source);
  expect(orderByIds(source, [])).toEqual([last, second, third]);
  const ordered = orderByIds(source, ['c', 'missing', 'c']);
  expect(ordered).toEqual([third, last, second]);
  expect(ordered[0]).toBe(third);
  expect(ordered[1]).toBe(last);
  expect(source).toEqual([first, second, last, third]);
});

test('formatRuntime collapses bare minute counts and passes prose through', () => {
  expect(formatRuntime('142')).toBe('2h 22m');
  expect(formatRuntime('120')).toBe('2h');
  expect(formatRuntime('45')).toBe('45m');
  expect(formatRuntime('45 min')).toBe('45 min');
  expect(formatRuntime('1h 30m')).toBe('1h 30m');
  expect(formatRuntime('0')).toBe('0');
  expect(formatRuntime('  ')).toBeUndefined();
  expect(formatRuntime(undefined)).toBeUndefined();
});

test('mediaTypeLabel titlecases addon-declared types', () => {
  expect(mediaTypeLabel('channel')).toBe('Channel');
  expect(mediaTypeLabel(' movie ')).toBe('Movie');
  expect(mediaTypeLabel('series')).toBe('TV Series');
  expect(mediaTypeLabel('anime')).toBe('Anime');
  expect(mediaTypeLabel(undefined)).toBe('Movie');
});

test('resolvePlayerRouteMediaType passes addon-declared types through', () => {
  expect(resolvePlayerRouteMediaType('Channel')).toBe('channel');
  expect(resolvePlayerRouteMediaType('movie')).toBe('movie');
  expect(resolvePlayerRouteMediaType('anime')).toBe('anime');
  expect(resolvePlayerRouteMediaType('series')).toBe('series');
  expect(resolvePlayerRouteMediaType(undefined)).toBe('series');
  expect(resolvePlayerRouteMediaType('  ')).toBe('series');
});

test.each(['anime', 'channel'])(
  'preview invoke preserves %s media type across library, lists, details, and history',
  async (type) => {
    const item: MediaItem = { id: `preview-${type}`, title: type, type };
    const list = await previewInvoke<UserList>('create_list', { name: type });
    try {
      expect(await previewInvoke('add_to_library', { item })).toMatchObject(item);
      expect(await previewInvoke('add_to_list', { listId: list.id, item })).toMatchObject({
        item_count: 1,
      });
      expect(await previewInvoke('set_watch_status', { item, status: 'watching' })).toMatchObject(
        item,
      );
      expect(
        await previewInvoke('get_media_details', { mediaType: ` ${type.toUpperCase()} ` }),
      ).toMatchObject({ type });
    } finally {
      await Promise.all([
        previewInvoke('remove_from_library', { id: item.id }),
        previewInvoke('delete_list', { listId: list.id }),
      ]);
    }
  },
);

test('preview invoke preserves history routing and rejects blank media types', async () => {
  const plans = await Promise.all(
    (
      [
        ['movie', 'title', 'player', 'movie'],
        [' Channel ', 'title', 'player', 'channel'],
        ['series', 'title', 'details', 'series'],
        ['anime', 'title', 'details', 'anime'],
        ['', 'KITSU:1', 'details', 'anime'],
        ['', 'title', 'details', 'series'],
      ] as const
    ).map(async ([type_, id, kind, routeType]) => {
      const plan = await previewInvoke<HistoryPlaybackPlan>('build_history_playback_plan', {
        item: { id, type_ },
      });
      return [plan.kind, plan.target, kind, `/${kind}/${routeType}/${encodeURIComponent(id)}`];
    }),
  );
  for (const [actualKind, actualTarget, kind, target] of plans) {
    expect([actualKind, actualTarget]).toEqual([kind, target]);
  }
  await Promise.all(
    ['', '   ', 42, null].map((type) =>
      expect(
        previewInvoke('add_to_library', { item: { id: 'invalid', title: 'Invalid', type } }),
      ).rejects.toThrow('Invalid media item'),
    ),
  );
  expect(await previewInvoke('get_media_details', { mediaType: '   ' })).toMatchObject({
    type: 'movie',
  });
});

for (const role of ['radio', 'tab'] as const) {
  test.each([
    [0, 'ArrowLeft', 2, {}],
    [2, 'ArrowRight', 0, {}],
    [0, 'ArrowDown', 1, {}],
    [2, 'ArrowUp', 1, {}],
    [2, 'Home', 0, {}],
    [0, 'End', 2, {}],
    [0, 'Home', 0, {}],
    [0, 'x', null, {}],
    [0, 'ArrowRight', null, { altKey: true }],
    [0, 'ArrowRight', null, { ctrlKey: true }],
    [0, 'ArrowRight', null, { metaKey: true }],
    [0, 'ArrowRight', null, { shiftKey: true }],
    [0, 'ArrowRight', null, { nativeEvent: { isComposing: true } }],
    [0, 'ArrowRight', null, { defaultPrevented: true }],
  ] as const)(
    `${role} navigation from %s with %s targets %s without scrolling`,
    (index, key, nextIndex, guard) => {
      const buttons = Array.from({ length: 3 }, () => ({
        focus: mock(() => {}),
        click: mock(() => {}),
      }));
      const querySelectorAll = mock((_selector: string) => buttons);
      const closest = mock((_selector: string) => ({ querySelectorAll }));
      const preventDefault = mock(() => {});
      const event = {
        key,
        nativeEvent: { isComposing: false },
        ...guard,
        currentTarget: Object.assign(buttons[index], { closest }),
        preventDefault,
      } as unknown as KeyboardEvent<HTMLButtonElement>;
      handleRovingGroupKeyDown(event, role);
      expect(preventDefault).toHaveBeenCalledTimes(nextIndex === null ? 0 : 1);
      const moves = nextIndex !== null && nextIndex !== index;
      expect(buttons.flatMap((button) => button.click.mock.calls)).toHaveLength(moves ? 1 : 0);
      if (moves) expect(buttons[nextIndex].focus).toHaveBeenCalledWith({ preventScroll: true });
      if (nextIndex !== null) {
        expect(closest).toHaveBeenCalledWith(
          role === 'tab' ? '[role="tablist"]' : '[role="radiogroup"]',
        );
        expect(querySelectorAll).toHaveBeenCalledWith(
          `button[role="${role}"]:not(:disabled):not([aria-disabled="true"])`,
        );
      } else {
        expect(closest).not.toHaveBeenCalled();
      }
    },
  );
}
