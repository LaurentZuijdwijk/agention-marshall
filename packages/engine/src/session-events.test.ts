import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFailure } from './session-events.js';

// The shapes below are copied from the tools that produce them, not invented:
// shell-tool.ts builds `parts.join('\n\n')` ending in an `exit code:` line,
// agent-tool.ts returns `JSON.stringify({ error })`, and the file tools return
// `Error: …`. If a tool changes how it reports failure, this is where it should
// break.

test('the Error: prefix every file and search tool uses', () => {
  assert.equal(isFailure('Error: oldString not found in a.js.'), true);
  assert.equal(isFailure('Successfully edited a.js'), false);
});

// The gap this closes: run_shell reports the command's outcome, not the call's,
// so a failing build or test suite carried no `Error:` and never reached the
// log — the single most expensive kind of failure to lose.
test('run_shell reports failure as a trailing exit code, and that counts', () => {
  assert.equal(isFailure('stdout:\nok\n\nexit code: 0'), false);
  assert.equal(isFailure('stdout:\n\n\nstderr:\nboom\n\nexit code: 1'), true);
  assert.equal(isFailure('exit code: null'), true);
  assert.equal(isFailure('stderr:\nkilled\n\n(command timed out and was killed)\n\nexit code: null'), true);
});

// Anchored to the end of the result for a reason: the exit-code line is always
// last, and a command is perfectly entitled to print that phrase itself.
test('a command that merely prints the words "exit code" is not a failure', () => {
  assert.equal(isFailure('stdout:\nexit code: 1\n\nexit code: 0'), false,
    'the real outcome is the last line, and it succeeded');
});

test('agent-tool answers in JSON, and its error key counts', () => {
  assert.equal(isFailure(JSON.stringify({ error: 'Failed to execute instructions: no profile' })), true);
  assert.equal(isFailure(JSON.stringify({ report: 'done: nothing to change' })), false);
});

// Neither is the model getting something wrong, and conflating them would make
// "the edit failed" in a log mean "a human said no".
test('an approval denial and an interruption are not tool failures', () => {
  assert.equal(isFailure('Tool call denied by user.'), false);
  assert.equal(isFailure('Task interrupted by user'), false);
});
