import { expect, test } from 'bun:test';
import { Children, isValidElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EpisodeThumb } from '../src/components/episode-thumb';
import { RemoteImage } from '../src/components/remote-image';

test('episode artwork falls back once at runtime, then reveals its label', () => {
  const src = 'https://episodes.example/missing.jpg';
  const fallbackSrc = 'https://images.example/backdrop.jpg';
  const thumb = EpisodeThumb({ episode: 4, src, fallbackSrc, progressPercent: 42, fadeIn: true });
  const remote = Children.toArray(thumb.props.children).find(
    (child) => isValidElement(child) && child.type === RemoteImage,
  );
  if (!isValidElement<ComponentProps<typeof RemoteImage>>(remote)) throw new Error('Missing image');
  expect(remote.props.src).toBe(src);
  expect(remote.props.fallbackSrc).toBe(fallbackSrc);
  expect(remote.props.fadeIn).toBe(true);
  const image = RemoteImage(remote.props);
  const target = { src, dataset: { loaded: 'true' }, style: { display: '' } };
  const fail = () => image.props.onError({ currentTarget: target });
  fail();
  expect(target.src).toBe(fallbackSrc);
  expect(target.dataset.loaded).toBeUndefined();
  expect(target.style.display).toBe('');
  fail();
  expect(target.style.display).toBe('none');
  expect(renderToStaticMarkup(thumb)).toContain('E4');
});

test('episode artwork uses series art for missing thumbnails and preserves overlay chrome', () => {
  const markup = renderToStaticMarkup(
    <EpisodeThumb
      episode={4}
      fallbackSrc='https://images.example/backdrop.jpg'
      fallbackLabel={4}
      progressPercent={42}
      isSpoiler
    >
      <span>Play next</span>
    </EpisodeThumb>,
  );
  expect(markup).toContain('src="https://images.example/backdrop.jpg"');
  expect(markup).toContain('blur-md');
  expect(markup).toContain('>4</div>');
  expect(markup).toContain('Play next');
  expect(markup).toContain('42%');
});
