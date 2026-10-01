// Markdown-lite shaping for GitHub release bodies — rendered by
// Settings → Updates. Not a markdown engine: headings, bullets, and inline
// noise are normalized just enough to read cleanly inside the app's own
// typography.

export interface ReleaseNoteBlock {
  kind: 'heading' | 'bullet' | 'text';
  text: string;
  /** Append index within the parsed body — parsed blocks are immutable,
      so position alone keeps React keys unique across repeated lines. */
  key: string;
}

function stripInlineMarkup(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/(\*\*|__)([^*_]+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/\b_([^_\n]+)_\b/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function parseReleaseNotes(body?: string | null): ReleaseNoteBlock[] {
  if (!body) return [];

  const blocks: ReleaseNoteBlock[] = [];
  const push = (kind: ReleaseNoteBlock['kind'], text: string) => {
    blocks.push({ kind, text, key: `${kind}-${blocks.length}` });
  };

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^[-=*_#]{3,}$/.test(line)) continue;

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const text = stripInlineMarkup(heading[1]);
      if (text) push('heading', text);
      continue;
    }

    const bullet = /^(?:[-*•‣·]|\d{1,2}[.)])\s+(.*)$/.exec(line);
    const text = stripInlineMarkup(bullet ? bullet[1] : line);
    if (text) push(bullet ? 'bullet' : 'text', text);
  }
  return blocks;
}
