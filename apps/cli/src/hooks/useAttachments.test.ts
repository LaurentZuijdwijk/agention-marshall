import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAttachments, describeImage, labelFor } from './useAttachments.js';
import type { ImageAttachment } from '@agentionai/marshall-engine';

const image = (data = 'AAAA'): ImageAttachment => ({ data, mimeType: 'image/png' });
/** `n` bytes of image, as the base64 string the store actually holds. */
const ofBytes = (n: number): ImageAttachment => image('x'.repeat(Math.ceil(n * 4 / 3)));

describe('describeImage', () => {
  it('reports the decoded size, not the base64 it inflates to', () => {
    assert.equal(describeImage(ofBytes(120 * 1024)), '120 KB png');
  });

  it('switches to MB once that reads better', () => {
    assert.equal(describeImage(ofBytes(2 * 1024 * 1024)), '2.0 MB png');
  });

  it('never rounds a real image down to nothing', () => {
    assert.equal(describeImage(image('AA')), '1 KB png');
  });
});

describe('createAttachments', () => {
  it('hands back a label per image, numbered from one', () => {
    const attachments = createAttachments();
    assert.equal(attachments.add(image()), labelFor(1));
    assert.equal(attachments.add(image()), labelFor(2));
  });

  it('attaches the images whose labels survived in the text', () => {
    const attachments = createAttachments();
    const first = attachments.add(image('ONE'));
    const second = attachments.add(image('TWO'));

    assert.deepEqual(
      attachments.attachedTo(`compare ${first} with ${second}`).map(i => i.data),
      ['ONE', 'TWO'],
    );
  });

  it('drops an image whose label the user deleted', () => {
    // Backspacing the label out of the prompt is how you cancel an attachment.
    // Sending it anyway would spend tokens on an image nobody meant to include.
    const attachments = createAttachments();
    attachments.add(image('ONE'));
    const second = attachments.add(image('TWO'));

    assert.deepEqual(attachments.attachedTo(`only ${second}`).map(i => i.data), ['TWO']);
  });

  it('sends nothing when no label is left', () => {
    const attachments = createAttachments();
    attachments.add(image());
    assert.deepEqual(attachments.attachedTo('never mind'), []);
  });

  it('keeps label order, not the order they appear in the text', () => {
    // The labels are what the model sees, so #1 must be the first image.
    const attachments = createAttachments();
    const first = attachments.add(image('ONE'));
    const second = attachments.add(image('TWO'));

    assert.deepEqual(
      attachments.attachedTo(`${second} then ${first}`).map(i => i.data),
      ['ONE', 'TWO'],
    );
  });

  it('describes a stored image and shrugs at an unknown label', () => {
    const attachments = createAttachments();
    const label = attachments.add(ofBytes(50 * 1024));
    assert.equal(attachments.describe(label), '50 KB png');
    assert.equal(attachments.describe('[image #9]'), '');
  });

  it('forgets everything on clear, and renumbers from one', () => {
    const attachments = createAttachments();
    const label = attachments.add(image());
    attachments.clear();

    assert.deepEqual(attachments.attachedTo(label), []);
    assert.equal(attachments.add(image()), labelFor(1));
  });
});
