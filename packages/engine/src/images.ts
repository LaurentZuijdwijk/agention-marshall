import { text, imageBase64 } from '@agentionai/agents/core';
import type { MessageContent, ImageMimeType } from '@agentionai/agents/core';
import type { AgentProfile, Provider } from './config.js';

/** An image travelling with a task, as raw base64 — no `data:` prefix. */
export interface ImageAttachment {
  data: string;
  mimeType: ImageMimeType;
}

export const IMAGE_MIME_TYPES: ImageMimeType[] = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
];

/**
 * Anthropic rejects images over 5MB and it is the tightest of the providers we
 * talk to, so one limit covers all of them.
 *
 * Measured on the decoded image, not the base64 that carries it. Providers
 * publish their limits that way, and it is also the number a user can check
 * against the file on disk — a cap on the encoded text would reject a 3.8MB
 * screenshot while claiming a 5MB limit.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Size of the image itself; base64 inflates it by 4/3 in transit. */
export function decodedBytes(data: string): number {
  return Math.floor(data.length * 3 / 4);
}

/**
 * Why a provider cannot carry an attached image, or null when it can.
 *
 * Established by running a base64 image through each of the library's history
 * transformers rather than from documentation — and the surprise is `ollama`,
 * whose transformer ignores image blocks completely. That is the case worth
 * refusing loudest: the request succeeds and the model answers confidently
 * about an image it was never sent.
 *
 * The two locally-hosted paths are absent on purpose. Whether they work depends
 * on the model loaded, not the provider, and that is knowledge we do not have
 * here — refusing outright would block every legitimate vision model behind
 * llama.cpp or OpenRouter.
 */
const CANNOT_SEND_IMAGES: Partial<Record<Provider, string>> = {
  ollama: 'the ollama provider drops images before the request is sent, so the model would answer without ever seeing them',
  mistral: 'mistral accepts images only by URL, not as uploaded data',
};

/** The reason this task cannot be sent as-is, or null when it can. */
export function checkAttachments(
  profile: AgentProfile,
  images: ImageAttachment[],
): string | null {
  if (images.length === 0) return null;

  const unsupported = CANNOT_SEND_IMAGES[profile.provider];
  if (unsupported) {
    return `Cannot attach an image: ${unsupported}. Switch the deep model to another provider, or send the task without it.`;
  }

  for (const [i, image] of images.entries()) {
    if (!IMAGE_MIME_TYPES.includes(image.mimeType)) {
      return `Image ${i + 1} is a ${image.mimeType}, which no provider accepts. Use PNG, JPEG, GIF or WebP.`;
    }
    const bytes = decodedBytes(image.data);
    if (bytes > MAX_IMAGE_BYTES) {
      // Same units the client used when it announced the attachment, so the
      // refusal names the size the user already saw rather than a bigger one.
      const mb = (bytes / 1024 / 1024).toFixed(1);
      return `Image ${i + 1} is ${mb} MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit. Crop or scale it down first.`;
    }
  }

  return null;
}

/**
 * The task as the agent should receive it.
 *
 * Stays a plain string when nothing is attached — most of the engine treats the
 * task as text (steering, logging, the interrupted-task note), and only the
 * agent call needs the richer shape.
 */
export function buildInput(task: string, images: ImageAttachment[]): string | MessageContent[] {
  if (images.length === 0) return task;
  return [
    text(task),
    ...images.map(image => imageBase64(image.data, image.mimeType)),
  ];
}
