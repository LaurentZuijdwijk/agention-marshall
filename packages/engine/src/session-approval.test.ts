import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalDecision, ApprovalRequest } from '@agentionai/marshall-tools';
import { createApprovalGate } from './session-approval.js';
import type { EngineConfig } from './config.js';

const CONFIG: EngineConfig = {
  agent: { provider: 'claude', apiKey: 'k' },
  workspaceRoot: '/tmp',
};

/** A gate wired to a client that records what it was asked to approve. */
function gate(answer: (req: ApprovalRequest) => ApprovalDecision = () => 'approve') {
  const asked: ApprovalRequest[] = [];
  const g = createApprovalGate({
    getConfig: () => CONFIG,
    client: {
      onOutput: () => {},
      requestApproval: async (req) => { asked.push(req); return answer(req); },
    },
    log: () => {},
  });
  return { gate: g, asked };
}

function write(path: string, content = 'x'): ApprovalRequest {
  return {
    toolName: 'write_file',
    description: `Write file: ${path}`,
    detail: `--- ${path}\n+ ${content}`,
    input: { path, content },
  };
}

// Coalescing exists so that one batch of identical calls costs one decision.
// Keyed on the tool name alone it went much further than that: every concurrent
// call to the same *tool* shared one answer, whatever it was asking to do. A
// model emitting three write_file calls in one message is ordinary, so
// approving the diff for one file silently wrote the other two.
test('concurrent writes to different files each get their own decision', async () => {
  const { gate: g, asked } = gate();

  const [a, b, c] = await Promise.all([
    g.approve(write('a.ts')),
    g.approve(write('b.ts')),
    g.approve(write('c.ts')),
  ]);

  assert.deepEqual([a, b, c], ['approve', 'approve', 'approve']);
  assert.equal(asked.length, 3, 'each distinct write must be shown, not inherit another one\'s answer');
  assert.deepEqual(asked.map(r => (r.input as { path: string }).path).sort(), ['a.ts', 'b.ts', 'c.ts']);
});

test('denying one concurrent write does not deny the others', async () => {
  const { gate: g, asked } = gate((req) => (req.input as { path: string }).path === 'bad.ts' ? 'deny' : 'approve');

  const [good, bad] = await Promise.all([
    g.approve(write('good.ts')),
    g.approve(write('bad.ts')),
  ]);

  assert.equal(good, 'approve');
  assert.equal(bad, 'deny');
  assert.equal(asked.length, 2);
});

// The behaviour coalescing was actually for: a model repeating the identical
// call, where two prompts for the same thing would be noise.
test('genuinely identical concurrent calls still share one decision', async () => {
  const { gate: g, asked } = gate();
  const req = write('same.ts');

  const results = await Promise.all([g.approve(req), g.approve(req), g.approve(req)]);

  assert.deepEqual(results, ['approve', 'approve', 'approve']);
  assert.equal(asked.length, 1, 'the same question asked three times is still one question');
});

test('different callers asking about the same file are asked separately', async () => {
  const { gate: g, asked } = gate();
  const base = write('shared.ts');

  await Promise.all([
    g.approve({ ...base, caller: { role: 'coder', model: 'a/b' } }),
    g.approve({ ...base, caller: { role: 'swarm:fast', model: 'c/d' } }),
  ]);

  assert.equal(asked.length, 2, 'who is asking is part of what is being consented to');
});

// Role is not identity once work is fanned out. Two agents on the same role
// and model are the same string, and keying on that alone would put them back
// on one shared consent — the very bug this key exists to prevent, one level
// further down.
test('two live agents on the same role are asked separately', async () => {
  const { gate: g, asked } = gate();
  const base = write('shared.ts');
  const model = 'openrouter/x';

  await Promise.all([
    g.approve({ ...base, caller: { role: 'swarm:fast', model, id: 'swarm:fast#0' } }),
    g.approve({ ...base, caller: { role: 'swarm:fast', model, id: 'swarm:fast#1' } }),
  ]);

  assert.equal(asked.length, 2, 'same role, same model, different agent — two consents');
});

test('a role with no instance id still coalesces with itself', async () => {
  const { gate: g, asked } = gate();
  const caller = { role: 'coder', model: 'a/b' };
  const req = { ...write('same.ts'), caller };

  await Promise.all([g.approve(req), g.approve(req)]);

  assert.equal(asked.length, 1, 'the coder is singular, so nothing to disambiguate');
});

test('"always" covers later calls to the same tool', async () => {
  const { gate: g, asked } = gate(() => 'always');

  assert.equal(await g.approve(write('first.ts')), 'always');
  // A separate, later call: the always-list answers it without asking again.
  assert.equal(await g.approve(write('second.ts')), 'approve');
  assert.equal(asked.length, 1);
});

test('reset clears consent given for the session', async () => {
  const { gate: g, asked } = gate(() => 'always');

  await g.approve(write('first.ts'));
  g.reset();
  await g.approve(write('second.ts'));

  assert.equal(asked.length, 2, 'after /clear the always-list must not survive');
});
