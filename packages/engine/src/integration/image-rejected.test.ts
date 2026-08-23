// ── engine integration: image rejected by the provider ───────────────────────
//
// llama.cpp answers a model with no mmproj loaded by rejecting the request
// outright rather than dropping the image (see images.ts for why the engine
// cannot preempt this for llamacpp — it has no way to know ahead of time
// whether the loaded model can see). This is asserted through the fake HTTP
// provider, the same way light-mode.test.ts does, so the failure comes
// through the real request/response path rather than a mocked classifier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from '../session.js';
import { startFakeProvider } from '../testing/fake-provider.js';
import type { FakeProvider } from '../testing/fake-provider.js';
import type { ClientInterface, EngineConfig, OutputEvent, ImageAttachment } from '../index.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-image-rejected-'));
}

function makeClient(events: OutputEvent[]): ClientInterface {
  return {
    onOutput: (event) => { events.push(event); },
    requestApproval: async () => 'approve',
  };
}

function makeSession(root: string, fake: FakeProvider, client: ClientInterface, extra: Partial<EngineConfig> = {}): Session {
  return new Session(
    {
      agent: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
      workspaceRoot: root,
      compressionThreshold: 0,
      enableWebSearch: false,
      ...extra,
    },
    client,
  );
}

const PIXEL: ImageAttachment = {
  // A 1x1 PNG's worth of nonsense — the fake provider never decodes it, and
  // the engine's own size/mime checks (images.test.ts) already cover that.
  data: Buffer.from('not a real png').toString('base64'),
  mimeType: 'image/png',
};

const MMPROJ_ERROR = 'image input is not supported - hint: if this is unexpected, you may need to provide the mmproj';

test('an image rejected by the provider fires image-rejected, not the generic error', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ error: { status: 400, message: MMPROJ_ERROR } });
  t.after(() => fake.close());

  const events: OutputEvent[] = [];
  const session = makeSession(root, fake, makeClient(events));
  await session.run('build a sliding door', [PIXEL]);
  session.dispose();

  const rejected = events.filter(e => e.type === 'image-rejected');
  assert.equal(rejected.length, 1, `expected exactly one image-rejected event, got ${JSON.stringify(events.map(e => e.type))}`);
  assert.match(rejected[0].message, /mmproj/);
  assert.equal(rejected[0].task, 'build a sliding door');

  assert.equal(events.filter(e => e.type === 'error').length, 0, 'the generic error event must not also fire');
});

test('a retry after an image rejection does not resend the rejected turn', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    { error: { status: 400, message: MMPROJ_ERROR } },
    { text: 'done' },
  );
  t.after(() => fake.close());

  const events: OutputEvent[] = [];
  const session = makeSession(root, fake, makeClient(events));
  await session.run('build a sliding door', [PIXEL]);
  await session.run('build a sliding door', []); // what the client sends for "remove image and retry"
  session.dispose();

  assert.equal(fake.requests.length, 2);
  // The first request carried the image; the retry's history must not still
  // contain it (i.e. the rejected turn was popped rather than left in place).
  const retryBody = JSON.stringify(fake.requests[1].messages);
  assert.doesNotMatch(retryBody, /image_url|base64/);
});
