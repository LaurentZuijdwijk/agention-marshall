import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkAttachments, buildInput, MAX_IMAGE_BYTES } from './images.js';
import type { ImageAttachment } from './images.js';
import type { AgentProfile, Provider } from './config.js';

const png = (data = 'AAAA'): ImageAttachment => ({ data, mimeType: 'image/png' });
const on = (provider: Provider): AgentProfile => ({ provider });

describe('checkAttachments', () => {
  it('says nothing when there is nothing attached', () => {
    for (const provider of ['claude', 'ollama', 'mistral'] as Provider[]) {
      assert.equal(checkAttachments(on(provider), []), null);
    }
  });

  it('lets the providers whose transformers carry images through', () => {
    for (const provider of ['claude', 'openai', 'gemini', 'llamacpp', 'openrouter'] as Provider[]) {
      assert.equal(checkAttachments(on(provider), [png()]), null, provider);
    }
  });

  it('refuses ollama, which would drop the image and answer anyway', () => {
    // The dangerous one: the request succeeds, so without this the user gets a
    // confident answer about an image the model never received.
    const refusal = checkAttachments(on('ollama'), [png()]);
    assert.match(refusal ?? '', /drops images/);
  });

  it('refuses mistral, which only takes images by URL', () => {
    assert.match(checkAttachments(on('mistral'), [png()]) ?? '', /only by URL/);
  });

  it('refuses a format no provider accepts', () => {
    const bmp = { data: 'AAAA', mimeType: 'image/bmp' } as unknown as ImageAttachment;
    assert.match(checkAttachments(on('claude'), [bmp]) ?? '', /PNG, JPEG, GIF or WebP/);
  });

  it('refuses an image over the size limit, and says which one', () => {
    const huge = png('x'.repeat(MAX_IMAGE_BYTES + 1));
    const refusal = checkAttachments(on('claude'), [png(), huge]);
    assert.match(refusal ?? '', /^Image 2 is /);
    assert.match(refusal ?? '', /5MB limit/);
  });

  it('accepts an image exactly at the limit', () => {
    assert.equal(checkAttachments(on('claude'), [png('x'.repeat(MAX_IMAGE_BYTES))]), null);
  });
});

describe('buildInput', () => {
  it('stays a plain string when nothing is attached', () => {
    assert.equal(buildInput('what changed?', []), 'what changed?');
  });

  it('puts the text first, then each image', () => {
    const input = buildInput('why is this wrong?', [png('ONE'), png('TWO')]);
    assert.ok(Array.isArray(input));
    assert.deepEqual(
      (input as Array<{ type: string }>).map(block => block.type),
      ['text', 'image_base64', 'image_base64'],
      // The library's own discriminants — pinned because a rename here would
      // silently produce blocks the transformers ignore.
    );
  });

  it('carries the data and mime type the caller gave', () => {
    const input = buildInput('look', [{ data: 'SENTINEL', mimeType: 'image/webp' }]);
    const json = JSON.stringify(input);
    assert.match(json, /SENTINEL/);
    assert.match(json, /image\/webp/);
  });
});
