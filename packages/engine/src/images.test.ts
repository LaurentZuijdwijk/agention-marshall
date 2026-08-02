import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkAttachments, buildInput, MAX_IMAGE_BYTES } from './images.js';
import type { ImageAttachment } from './images.js';
import type { AgentProfile, Provider } from './config.js';

const png = (data = 'AAAA'): ImageAttachment => ({ data, mimeType: 'image/png' });
const on = (provider: Provider): AgentProfile => ({ provider });
/** Base64 text for an image of `bytes` decoded size. */
const base64Of = (bytes: number) => 'x'.repeat(Math.ceil(bytes * 4 / 3));

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
    const refusal = checkAttachments(on('claude'), [png(), png(base64Of(6 * 1024 * 1024))]);
    assert.match(refusal ?? '', /^Image 2 is /);
    assert.match(refusal ?? '', /6\.0 MB, over the 5 MB limit/,
      'the size quoted is the decoded one the client already showed the user');
  });

  it('accepts an image just under the limit', () => {
    // The cap is on the image, not the base64 that carries it. Measured the
    // other way this 5MB screenshot would be "6.7MB" and refused against a
    // limit the message claims is 5MB.
    assert.equal(checkAttachments(on('claude'), [png(base64Of(MAX_IMAGE_BYTES - 1))]), null);
  });

  it('refuses one just over', () => {
    assert.match(checkAttachments(on('claude'), [png(base64Of(MAX_IMAGE_BYTES + 8))]) ?? '', /over the/);
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
