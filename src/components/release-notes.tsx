import { parseReleaseNotes } from '@/lib/release-notes';
import { cn } from '@/lib/utils';

/** Structured render of a GitHub release body: heading eyebrows, dotted
    bullets, and plain paragraphs — replaces raw whitespace-pre-wrap dumps. */
export function ReleaseNotes({ body, className }: { body?: string | null; className?: string }) {
  const blocks = parseReleaseNotes(body);

  if (blocks.length === 0) {
    return (
      <p className='text-[13px] leading-relaxed text-zinc-500'>
        This release has no published notes.
      </p>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      {blocks.map((block) =>
        block.kind === 'heading' ? (
          <p
            key={block.key}
            className='pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500 first:pt-0'
          >
            {block.text}
          </p>
        ) : block.kind === 'bullet' ? (
          <p key={block.key} className='flex gap-2.5 text-[13px] leading-[1.6] text-zinc-300'>
            <span
              aria-hidden='true'
              className='mt-[9px] h-1 w-1 shrink-0 rounded-full bg-zinc-500'
            />
            <span className='min-w-0'>{block.text}</span>
          </p>
        ) : (
          <p key={block.key} className='text-[13px] leading-[1.6] text-zinc-300'>
            {block.text}
          </p>
        ),
      )}
    </div>
  );
}
