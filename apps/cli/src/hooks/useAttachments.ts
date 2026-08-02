import { useRef } from 'react';
import type { ImageAttachment } from '@agentionai/marshall-engine';

/**
 * Images waiting to go out with the next task, each standing in the prompt as a
 * short label.
 *
 * The label stays in the text that is sent, rather than being stripped: with
 * more than one image attached it is the only way to say *which* one a sentence
 * is about ("the error in [image #2]"). It is deliberately short and free of
 * byte counts for the same reason — the size matters to the person typing, not
 * to the model, so it belongs in the transcript row instead.
 */
export interface Attachments {
  /** Store an image and return the label that stands for it. */
  add(image: ImageAttachment): string;
  /** Every image whose label still appears in `value`, in label order. */
  attachedTo(value: string): ImageAttachment[];
  /** A human-readable size, for the row that announces the attachment. */
  describe(label: string): string;
  clear(): void;
}

export function labelFor(id: number): string {
  return `[image #${id}]`;
}

/** Base64 inflates by 4/3; report what was on the clipboard, not what we send. */
export function describeImage(image: ImageAttachment): string {
  const bytes = Math.floor(image.data.length * 3 / 4);
  const size = bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${size} ${image.mimeType.replace('image/', '')}`;
}

export function createAttachments(): Attachments {
  const store = new Map<string, ImageAttachment>();
  let nextId = 1;

  return {
    add(image: ImageAttachment): string {
      const label = labelFor(nextId++);
      store.set(label, image);
      return label;
    },

    // Driven by the text, not by insertion order: an image whose label the user
    // deleted should not be sent, and re-typing the label brings it back.
    attachedTo(value: string): ImageAttachment[] {
      const attached: ImageAttachment[] = [];
      for (const [label, image] of store) {
        if (value.includes(label)) attached.push(image);
      }
      return attached;
    },

    describe(label: string): string {
      const image = store.get(label);
      return image ? describeImage(image) : '';
    },

    clear(): void {
      store.clear();
      nextId = 1;
    },
  };
}

export function useAttachments(): Attachments {
  // Initialised by hand: `useRef(createAttachments())` would build a new store
  // every render and throw all but the first away.
  const attachments = useRef<Attachments | null>(null);
  attachments.current ??= createAttachments();
  return attachments.current;
}
