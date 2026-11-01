/** Chapter-style cuts: a 2px see-through gap at every interior edge of `seconds`. */
export function chapterCutMask(duration: number, seconds: readonly number[]) {
  if (duration <= 0) return undefined;
  const cuts = [...new Set(seconds)]
    .map((value) => (value / duration) * 100)
    .filter((pct) => pct > 0 && pct < 100)
    .toSorted((a, b) => a - b);
  if (!cuts.length) return undefined;
  const stops = cuts.map(
    (pct) =>
      `#000 calc(${pct}% - 1px), transparent calc(${pct}% - 1px) calc(${pct}% + 1px), #000 calc(${pct}% + 1px)`,
  );
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
