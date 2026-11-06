import { expect, test } from 'bun:test';
import { formatRuntime } from '../src/lib/utils';

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
