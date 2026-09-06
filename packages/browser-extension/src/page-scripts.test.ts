// page-scripts.ts's functions are written to run inside a real page — they
// reference the global `document`/`getComputedStyle`/`KeyboardEvent`, not an
// injected one — so this is the one place in the extension worth a real DOM
// rather than a fake: jsdom, patched onto the global scope for the duration
// of each test and restored after, since these functions have no way to
// take a document as a parameter (chrome.scripting.executeScript calls them
// with none).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractMarkdown, extractText, extractHtml, dispatchKeyPress } from './page-scripts.js';

let restore: (() => void) | null = null;

function useDom(html: string, url = 'https://example.com/page'): void {
  const dom = new JSDOM(html, { url });
  const g = globalThis as Record<string, unknown>;
  const saved = {
    document: g.document, window: g.window, Node: g.Node,
    getComputedStyle: g.getComputedStyle, KeyboardEvent: g.KeyboardEvent,
  };
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  g.KeyboardEvent = dom.window.KeyboardEvent;
  restore = () => Object.assign(g, saved);
}

afterEach(() => { restore?.(); restore = null; });

describe('extractMarkdown', () => {
  test('renders headings and paragraphs', () => {
    useDom('<body><h1>Title</h1><h2>Sub</h2><p>Hello world.</p></body>');
    const md = extractMarkdown();
    assert.match(md, /^# Title/);
    assert.match(md, /## Sub/);
    assert.match(md, /Hello world\./);
  });

  test('keeps a link\'s href, resolved to an absolute URL', () => {
    useDom(
      '<body><p>See <a href="/about">about us</a> and ' +
      '<a href="https://other.com/x">external</a>.</p></body>',
    );
    const md = extractMarkdown();
    assert.match(md, /\[about us\]\(https:\/\/example\.com\/about\)/);
    assert.match(md, /\[external\]\(https:\/\/other\.com\/x\)/);
  });

  test('renders bold, italic and inline code', () => {
    useDom('<body><p>This is <strong>bold</strong>, <em>italic</em>, and <code>code</code>.</p></body>');
    const md = extractMarkdown();
    assert.match(md, /\*\*bold\*\*/);
    assert.match(md, /\*italic\*/);
    assert.match(md, /`code`/);
  });

  test('renders unordered and ordered lists', () => {
    useDom('<body><ul><li>alpha</li><li>beta</li></ul><ol><li>one</li><li>two</li></ol></body>');
    const md = extractMarkdown();
    assert.match(md, /- alpha/);
    assert.match(md, /- beta/);
    assert.match(md, /1\. one/);
    assert.match(md, /2\. two/);
  });

  test('renders a code block and a blockquote', () => {
    useDom('<body><pre>const x = 1;</pre><blockquote>a wise quote</blockquote></body>');
    const md = extractMarkdown();
    assert.match(md, /```\nconst x = 1;\n```/);
    assert.match(md, /> a wise quote/);
  });

  test('renders an image with its alt text and absolute src', () => {
    useDom('<body><img src="/pic.png" alt="a picture"></body>');
    const md = extractMarkdown();
    assert.match(md, /!\[a picture\]\(https:\/\/example\.com\/pic\.png\)/);
  });

  test('skips elements hidden with display:none or visibility:hidden', () => {
    useDom(
      '<body><p>visible</p><p style="display:none">hidden one</p>' +
      '<p style="visibility:hidden">hidden two</p></body>',
    );
    const md = extractMarkdown();
    assert.match(md, /visible/);
    assert.doesNotMatch(md, /hidden one/);
    assert.doesNotMatch(md, /hidden two/);
  });

  test('drops script and style content entirely', () => {
    useDom('<body><p>real content</p><script>evilCode()</script><style>.x{color:red}</style></body>');
    const md = extractMarkdown();
    assert.match(md, /real content/);
    assert.doesNotMatch(md, /evilCode/);
    assert.doesNotMatch(md, /color:red/);
  });

  test('recurses into layout containers like div/section/article', () => {
    useDom('<body><div><section><article><p>buried content</p></article></section></div></body>');
    const md = extractMarkdown();
    assert.match(md, /buried content/);
  });

  test('collapses runs of blank lines', () => {
    useDom('<body><p>a</p><p></p><p></p><p>b</p></body>');
    const md = extractMarkdown();
    assert.doesNotMatch(md, /\n{3,}/);
  });
});

describe('extractText and extractHtml', () => {
  // extractText leans on document.body.innerText, which jsdom doesn't
  // implement (it has no layout engine to compute it from) — it returns
  // undefined here regardless of content, so there's nothing meaningful to
  // assert beyond "doesn't crash and falls back to a string". The real
  // whitespace-collapsing behaviour only runs in an actual browser; format
  // dispatch is covered separately in background.test.ts.
  test('extractText falls back to an empty string when innerText is unavailable', () => {
    useDom('<body><p>Hello   world</p><p><a href="/x">a link</a></p></body>');
    const text = extractText();
    assert.equal(typeof text, 'string');
  });

  test('extractHtml returns the full document markup', () => {
    useDom('<body><div id="marker">hi</div></body>');
    const html = extractHtml();
    assert.match(html, /<div id="marker">hi<\/div>/);
  });
});

describe('dispatchKeyPress', () => {
  test('dispatches keydown/keypress/keyup with the requested key and modifiers', () => {
    useDom('<body><input id="q"></body>');
    const seen: Array<{ type: string; key: string; ctrlKey: boolean }> = [];
    const el = document.getElementById('q')!;
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.addEventListener(type, (e) => {
        const ke = e as KeyboardEvent;
        seen.push({ type, key: ke.key, ctrlKey: ke.ctrlKey });
      });
    }

    const result = dispatchKeyPress('#q', 'Enter', { ctrlKey: true });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(seen, [
      { type: 'keydown', key: 'Enter', ctrlKey: true },
      { type: 'keypress', key: 'Enter', ctrlKey: true },
      { type: 'keyup', key: 'Enter', ctrlKey: true },
    ]);
    assert.equal(document.activeElement, el, 'the target should have been focused first');
  });

  test('falls back to the currently focused element when no selector is given', () => {
    useDom('<body><input id="a"><input id="b"></body>');
    const b = document.getElementById('b') as HTMLInputElement;
    b.focus();
    let receivedOn: string | null = null;
    document.getElementById('a')!.addEventListener('keydown', () => { receivedOn = 'a'; });
    b.addEventListener('keydown', () => { receivedOn = 'b'; });

    dispatchKeyPress(undefined, 'a', {});

    assert.equal(receivedOn, 'b');
  });

  test('reports an error, not a throw, for a selector matching nothing', () => {
    useDom('<body></body>');
    const result = dispatchKeyPress('#missing', 'Enter', {});
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /no element matches "#missing"/);
  });

  test('a single printable character gets a plausible keyCode, a named key its table value', () => {
    useDom('<body><input id="q"></body>');
    const codes: number[] = [];
    document.getElementById('q')!.addEventListener('keydown', (e) => codes.push((e as KeyboardEvent).keyCode));

    dispatchKeyPress('#q', 'a', {});
    dispatchKeyPress('#q', 'Escape', {});

    assert.equal(codes[0], 'a'.charCodeAt(0));
    assert.equal(codes[1], 27);
  });
});
