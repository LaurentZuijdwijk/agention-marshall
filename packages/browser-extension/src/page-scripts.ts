// Functions injected into a page via chrome.scripting.executeScript, kept in
// their own side-effect-free module for two reasons: `background.ts` faking
// chrome.*/WebSocket globals to import anything from it is unrelated
// machinery these don't need, and — the harder constraint — an injected
// function is serialised with `Function.prototype.toString()` and re-run on
// its own in the page's world, so it must be *entirely* self-contained: no
// closures over anything outside its own body, helpers included (which is
// why each function below nests its own rather than calling a sibling).
// Passing one of these by reference to `func:` (rather than an inline arrow)
// works exactly the same way — Chrome only ever looks at the function's own
// source text.

export interface ScriptOutcome { ok: boolean; error?: string }

export function extractHtml(): string {
  return document.documentElement.outerHTML;
}

export function extractText(): string {
  const raw = document.body?.innerText ?? '';
  // innerText alone leaves trailing spaces and can pile up blank lines from
  // stacked block elements — real token savings, not just a format change,
  // is the point of this mode.
  return raw
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Keeps structure ('text' throws it away) at a fraction of 'html''s cost,
 * and — the thing neither of the other two modes can do at all — keeps a
 * link's destination attached to its text, so the model can act on a link
 * without a second read in 'html' mode just to find its href.
 *
 * A hand-rolled walker rather than a library: covers the common block
 * elements rather than chasing full CommonMark fidelity — nested lists in
 * particular are flattened, not indented.
 */
export function extractMarkdown(): string {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
  const CONTAINER_TAGS = new Set([
    'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
    'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH', 'FORM', 'SPAN',
  ]);

  function absolute(url: string): string {
    try { return new URL(url, document.baseURI).href; } catch { return url; }
  }

  // Renders one element as inline content — used both for each element child
  // encountered while walking a container (inline() below) and directly on a
  // "leaf" element that shows up as a block-level child in its own right
  // (e.g. a bare <img> or <a> under <body>, with no enclosing <p>): calling
  // inline() on such an element would walk its *children*, which is empty
  // for a childless element like <img> and silently produces nothing.
  function inlineOf(el: HTMLElement): string {
    if (SKIP_TAGS.has(el.tagName)) return '';
    switch (el.tagName) {
      case 'A': {
        const href = el.getAttribute('href');
        const text = inline(el).trim();
        return href && text ? `[${text}](${absolute(href)})` : text;
      }
      case 'STRONG': case 'B':
        return `**${inline(el).trim()}**`;
      case 'EM': case 'I':
        return `*${inline(el).trim()}*`;
      case 'CODE':
        return `\`${(el.textContent ?? '').trim()}\``;
      case 'BR':
        return '\n';
      case 'IMG': {
        const alt = el.getAttribute('alt') ?? '';
        const src = el.getAttribute('src');
        return src ? `![${alt}](${absolute(src)})` : '';
      }
      default:
        return inline(el);
    }
  }

  function inline(node: Node): string {
    let out = '';
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += (child.textContent ?? '').replace(/\s+/g, ' ');
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      out += inlineOf(child as HTMLElement);
    }
    return out;
  }

  function block(node: Node): string {
    let out = '';
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = (child.textContent ?? '').trim();
        if (t) out += t + '\n\n';
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as HTMLElement;
      if (SKIP_TAGS.has(el.tagName)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) {
        const t = inline(el).trim();
        if (t) out += '#'.repeat(Number(tag[1])) + ' ' + t + '\n\n';
      } else if (tag === 'P') {
        const t = inline(el).trim();
        if (t) out += t + '\n\n';
      } else if (tag === 'UL' || tag === 'OL') {
        let i = 1;
        for (const li of Array.from(el.children)) {
          if (li.tagName !== 'LI') continue;
          const marker = tag === 'OL' ? `${i++}.` : '-';
          const t = inline(li).trim();
          if (t) out += `${marker} ${t}\n`;
        }
        out += '\n';
      } else if (tag === 'BLOCKQUOTE') {
        const t = inline(el).trim();
        if (t) out += t.split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
      } else if (tag === 'PRE') {
        out += '```\n' + (el.textContent ?? '') + '\n```\n\n';
      } else if (tag === 'HR') {
        out += '---\n\n';
      } else if (CONTAINER_TAGS.has(tag)) {
        out += block(el);
      } else {
        const t = inlineOf(el).trim();
        if (t) out += t + '\n\n';
      }
    }
    return out;
  }

  return block(document.body ?? document.documentElement).replace(/\n{3,}/g, '\n\n').trim();
}

/** keyCode/which for the keys models actually reach for — best-effort only,
 *  for the (increasingly rare, but still real) listener that reads the
 *  numeric field instead of `.key`. Nested inside dispatchKeyPress rather
 *  than a sibling const for the same self-containment reason as everything
 *  else here. */
export interface KeyModifiers { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }

export function dispatchKeyPress(sel: string | undefined, k: string, mods: KeyModifiers): ScriptOutcome {
  const KEY_CODES: Record<string, number> = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ' ': 32,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
  };
  const target = (sel ? document.querySelector(sel) : document.activeElement) as HTMLElement | null;
  if (sel && !target) return { ok: false, error: `no element matches "${sel}"` };
  const el = target ?? document.body;
  el.focus?.();
  const keyCode = KEY_CODES[k] ?? (k.length === 1 ? k.charCodeAt(0) : 0);
  const init: KeyboardEventInit = {
    key: k, code: k, keyCode, which: keyCode,
    bubbles: true, cancelable: true, composed: true,
    ctrlKey: mods.ctrlKey ?? false, shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false, metaKey: mods.metaKey ?? false,
  };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return { ok: true };
}
