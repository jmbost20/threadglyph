// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findImageEmbeds, imageTitle } from '../src/anchor/imageEmbed';
import { commentable, imageTitlesExtension, titleRenderedImages } from '../src/ui/imageTitles';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('image titles', () => {
  it('uses words from the alias or alt text, else the file name', () => {
    expect(imageTitle('Evening sky', 'sky.png')).toBe('Evening sky');
    expect(imageTitle('Evening  sky|300', 'sky.png')).toBe('Evening sky');
    expect(imageTitle('300', 'Pics/sky.png')).toBe('sky');
    expect(imageTitle('300x200', 'sky.png')).toBe('sky');
    expect(imageTitle('', 'noext')).toBe('noext');
    const doc = '![[Pics/sky.png|Evening sky]] ![[meadow.png|120]] ![A map](maps/route%201.png) ![](plain.webp)';
    expect(findImageEmbeds(doc).map((e) => e.title)).toEqual(['Evening sky', 'meadow', 'A map', 'plain']);
  });

  it('never reports an embed nested inside another embed’s markup twice', () => {
    const doc = '![odd](<![[a.png]].png>) then ![[b.png]]';
    expect(findImageEmbeds(doc).map((e) => [e.from, e.wiki])).toEqual([
      [0, false],
      [doc.indexOf('![[b.png]]'), true],
    ]);
  });

  it('offers Comment only for local images in a supported format', () => {
    const [png, heic, remote] = findImageEmbeds('![[a.png]] ![[b.heic]] ![](https://x.org/c.png)');
    expect([commentable(png), commentable(heic), commentable(remote)]).toEqual([true, false, false]);
  });
});

describe('editor image titles', () => {
  function editor(doc: string) {
    const onComment = vi.fn();
    const view = new EditorView({ state: EditorState.create({ doc, extensions: imageTitlesExtension(onComment) }), parent: document.body });
    return { view, onComment };
  }

  it('draws a title with a Comment button after each supported image, without changing the text', () => {
    const doc = 'Look ![[sky.png|Evening sky]] and ![[x.heic]].\n![[b.jpg]]';
    const { view, onComment } = editor(doc);
    expect([...view.dom.querySelectorAll('.tg-image-title-text')].map((e) => e.textContent)).toEqual(['Evening sky', 'b']);
    const button = view.dom.querySelector<HTMLButtonElement>('.tg-image-comment')!;
    expect(button.getAttribute('aria-label')).toBe('Comment on image Evening sky');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    button.click();
    expect(onComment).toHaveBeenCalledWith(view, expect.objectContaining({ from: 5, link: 'sky.png', title: 'Evening sky' }));
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it('follows edits and leaves the titles alone on selection changes', () => {
    const { view } = editor('![[a.png]]');
    view.dispatch({ selection: { anchor: 3 } });
    expect(view.dom.querySelectorAll('.tg-image-title')).toHaveLength(1);
    view.dispatch({ changes: { from: 0, insert: 'Intro ' } });
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' ![[b.png|Second]]' } });
    expect([...view.dom.querySelectorAll('.tg-image-title-text')].map((e) => e.textContent)).toEqual(['a', 'Second']);
    view.destroy();
  });
});

describe('Reading view image titles', () => {
  const section = (html: string) => {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  };

  it('adds a title after each rendered wiki image, after its badge, with whole-note offsets', () => {
    const src = 'Intro\n\n![[sky.png|Sky]] ![[Other note]] ![[b.png]]\n';
    const start = src.indexOf('![[sky');
    const el = section(
      '<p><span class="internal-embed image-embed" src="sky.png|Sky"></span><span class="tg-badge">1</span> ' +
        '<span class="internal-embed" src="Other note"></span> <span class="internal-embed image-embed" src="b.png"></span></p>',
    );
    const onComment = vi.fn();
    expect(titleRenderedImages(el, src, start, src.length, onComment)).toBe(2);
    const titles = [...el.querySelectorAll('.tg-image-title')];
    expect(titles.map((t) => t.previousElementSibling?.className)).toEqual(['tg-badge', 'internal-embed image-embed']);
    titles[0].querySelector('button')!.click();
    expect(onComment).toHaveBeenCalledWith(expect.objectContaining({ from: start, to: start + '![[sky.png|Sky]]'.length, title: 'Sky' }));
    expect(titleRenderedImages(el, src, start, src.length, onComment)).toBe(1);
  });

  it('adds nothing when rendered images and source embeds do not line up', () => {
    const src = '![[a.png]] ![[b.png]]';
    expect(titleRenderedImages(section('<span class="internal-embed" src="a.png"></span>'), src, 0, src.length, vi.fn())).toBe(0);
    expect(titleRenderedImages(section('<p>No images</p>'), 'No images', 0, 9, vi.fn())).toBe(0);
    const heic = '![[x.heic]]';
    expect(titleRenderedImages(section('<span class="internal-embed" src="x.heic"></span>'), heic, 0, heic.length, vi.fn())).toBe(0);
  });
});
