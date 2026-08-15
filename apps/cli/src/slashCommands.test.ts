import { describe, it, expect } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSlashCommand, completeSlash, HELP, SLASH_COMMANDS, SUBCOMMANDS } from './slashCommands.js';

describe('slashCommands', () => {
  describe('resolveSlashCommand', () => {
    it('returns help for /help', () => {
      const result = resolveSlashCommand('/help');
      assert.equal(result.type, 'help');
    });

    it('returns exit for /exit', () => {
      const result = resolveSlashCommand('/exit');
      assert.equal(result.type, 'exit');
    });

    it('returns model targeting both tiers for bare /model', () => {
      const result = resolveSlashCommand('/model');
      assert.equal(result.type, 'model');
      assert.equal((result as { target: string }).target, 'both');
    });

    it('reads the tier from /model deep|fast|off', () => {
      for (const target of ['deep', 'fast', 'off']) {
        const result = resolveSlashCommand(`/model ${target}`);
        assert.equal(result.type, 'model');
        assert.equal((result as { target: string }).target, target);
      }
    });

    it('returns cwd for /cwd', () => {
      const result = resolveSlashCommand('/cwd');
      assert.equal(result.type, 'cwd');
    });

    it('returns memory for /memory', () => {
      const result = resolveSlashCommand('/memory');
      assert.equal(result.type, 'memory');
    });

    it('returns login for /login', () => {
      const result = resolveSlashCommand('/login');
      assert.equal(result.type, 'login');
    });

    it('returns clear for /clear', () => {
      const result = resolveSlashCommand('/clear');
      assert.equal(result.type, 'clear');
    });

    it('returns the current mode for bare /runtime', () => {
      assert.deepEqual(resolveSlashCommand('/runtime'), { type: 'runtime', mode: undefined, scope: 'project' });
    });

    it('reads default, light and agentic modes', () => {
      for (const mode of ['default', 'light', 'agentic']) {
        assert.deepEqual(resolveSlashCommand(`/runtime ${mode}`), { type: 'runtime', mode, scope: 'project' });
      }
    });

    it('takes --global on either side of the mode', () => {
      assert.deepEqual(resolveSlashCommand('/runtime light --global'), { type: 'runtime', mode: 'light', scope: 'global' });
      assert.deepEqual(resolveSlashCommand('/runtime --global light'), { type: 'runtime', mode: 'light', scope: 'global' });
    });

    it('rejects a bare --global, which asks to save nothing anywhere', () => {
      assert.equal(resolveSlashCommand('/runtime --global').type, 'usage');
    });

    it('rejects an unknown mode', () => {
      assert.equal(resolveSlashCommand('/runtime on').type, 'usage');
    });

    it('rejects two modes rather than picking one', () => {
      assert.equal(resolveSlashCommand('/runtime light default').type, 'usage');
    });

    it('is not a prefix of /model, so tab does not rewrite a complete command', () => {
      // The reason this is /runtime and not /mode: completing "/mode" turned it
      // into "/model", a different command entirely.
      assert.equal(completeSlash('/runtime'), '');
      assert.equal(completeSlash('/mod'), 'el');
    });

    it('opens the local settings menu by default', () => {
      assert.deepEqual(resolveSlashCommand('/setup'), { type: 'setup', scope: 'project' });
      assert.deepEqual(resolveSlashCommand('/setup local'), { type: 'setup', scope: 'project' });
    });

    it('opens the global settings menu when requested', () => {
      assert.deepEqual(resolveSlashCommand('/setup global'), { type: 'setup', scope: 'global' });
    });

    it('rejects invalid setup scopes', () => {
      assert.equal(resolveSlashCommand('/setup workspace').type, 'usage');
      assert.equal(resolveSlashCommand('/setup global extra').type, 'usage');
    });

    it('completes setup scopes', () => {
      assert.equal(completeSlash('/setup '), 'local');
      assert.equal(completeSlash('/setup g'), 'lobal');
    });

    it('returns safety with no level for bare /safety', () => {
      const result = resolveSlashCommand('/safety');
      assert.equal(result.type, 'safety');
      assert.equal((result as { level?: string }).level, undefined);
    });

    it('reads the level word from /safety yolo|default|agentic', () => {
      for (const level of ['yolo', 'default', 'agentic']) {
        const result = resolveSlashCommand(`/safety ${level}`);
        assert.equal(result.type, 'safety');
        assert.equal((result as { level?: string }).level, level);
      }
    });

    it('is case-insensitive on the level word', () => {
      const result = resolveSlashCommand('/safety AGENTIC');
      assert.equal(result.type, 'safety');
      assert.equal((result as { level?: string }).level, 'agentic');
    });

    it('rejects an unknown /safety level', () => {
      const result = resolveSlashCommand('/safety none');
      assert.equal(result.type, 'usage');
    });

    it('returns stream for /stream', () => {
      const result = resolveSlashCommand('/stream');
      assert.equal(result.type, 'stream');
    });

    it('returns tokens for /tokens', () => {
      const result = resolveSlashCommand('/tokens');
      assert.equal(result.type, 'tokens');
    });

    it('returns version and update commands', () => {
      assert.deepEqual(resolveSlashCommand('/version'), { type: 'version' });
      assert.deepEqual(resolveSlashCommand('/update'), { type: 'update' });
      assert.equal(resolveSlashCommand('/update now').type, 'usage');
    });

    it('returns plan with args for /plan <task>', () => {
      const result = resolveSlashCommand('/plan add a login form');
      assert.equal(result.type, 'plan');
      assert.equal((result as { args: string }).args, 'add a login form');
    });

    it('returns goal with args for /goal <task>', () => {
      const result = resolveSlashCommand('/goal add a login form');
      assert.equal(result.type, 'goal');
      assert.equal((result as { args: string }).args, 'add a login form');
    });

    it('returns review with empty args for bare /review', () => {
      const result = resolveSlashCommand('/review');
      assert.equal(result.type, 'review');
      assert.equal((result as { args: string }).args, '');
    });

    it('returns review with args for /review <notes>', () => {
      const result = resolveSlashCommand('/review check the auth changes');
      assert.equal(result.type, 'review');
      assert.equal((result as { args: string }).args, 'check the auth changes');
    });

    it('returns unknown for unrecognized slash command', () => {
      const result = resolveSlashCommand('/foobar');
      assert.equal(result.type, 'unknown');
      assert.equal((result as { command: string }).command, '/foobar');
    });

    it('returns unknown with full text for non-slash input', () => {
      const result = resolveSlashCommand('hello world');
      assert.equal(result.type, 'unknown');
      assert.equal((result as { command: string }).command, 'hello world');
    });

    it('returns usage for a /model argument that is not a tier', () => {
      const result = resolveSlashCommand('/model some-provider');
      assert.equal(result.type, 'usage');
      assert.match((result as { message: string }).message, /usage: \/model/);
    });

    it('returns usage for /plan with nothing to plan', () => {
      const result = resolveSlashCommand('/plan');
      assert.equal(result.type, 'usage');
      assert.match((result as { message: string }).message, /usage: \/plan/);
    });

    it('returns usage for /goal with nothing to aim at', () => {
      const result = resolveSlashCommand('/goal');
      assert.equal(result.type, 'usage');
      assert.match((result as { message: string }).message, /usage: \/goal/);
    });

    it('handles slash command with extra whitespace', () => {
      const result = resolveSlashCommand('  /help  ');
      assert.equal(result.type, 'help');
    });
  });

  describe('/jobs', () => {
    it('lists with no arguments', () => {
      assert.deepEqual(resolveSlashCommand('/jobs'), { type: 'jobs' });
    });

    it('takes an id to kill', () => {
      assert.deepEqual(resolveSlashCommand('/jobs kill job2'), { type: 'jobs', kill: 'job2' });
    });

    it('treats "all" as an id, so the command layer decides what it means', () => {
      assert.deepEqual(resolveSlashCommand('/jobs kill all'), { type: 'jobs', kill: 'all' });
    });

    it('rejects a verb it does not know', () => {
      const result = resolveSlashCommand('/jobs stop job1');
      assert.equal(result.type, 'usage');
    });

    it('rejects kill with no id', () => {
      assert.equal(resolveSlashCommand('/jobs kill').type, 'usage');
    });
  });

  describe('/mcp', () => {
    it('lists with no arguments', () => {
      assert.deepEqual(resolveSlashCommand('/mcp'), { type: 'mcp', action: 'list' });
    });

    it('opens the wizard for add, which takes no arguments', () => {
      assert.deepEqual(resolveSlashCommand('/mcp add'), { type: 'mcp', action: 'add' });
    });

    it('takes a server name for remove and reconnect', () => {
      assert.deepEqual(resolveSlashCommand('/mcp remove linear'), { type: 'mcp', action: 'remove', server: 'linear' });
      assert.deepEqual(resolveSlashCommand('/mcp reconnect linear'), { type: 'mcp', action: 'reconnect', server: 'linear' });
    });

    it('rejects remove and reconnect with no server named', () => {
      assert.equal(resolveSlashCommand('/mcp remove').type, 'usage');
      assert.equal(resolveSlashCommand('/mcp reconnect').type, 'usage');
    });

    it('rejects a verb it does not know', () => {
      assert.equal(resolveSlashCommand('/mcp frobnicate x').type, 'usage');
    });
  });

  describe('HELP text', () => {
    it('contains all command names', () => {
      for (const cmd of SLASH_COMMANDS) {
        assert.ok(HELP.includes(cmd), `HELP should include ${cmd}`);
      }
    });

    it('mentions esc shortcuts', () => {
      assert.ok(HELP.includes('Esc'), 'HELP should mention Esc');
    });

    it('mentions steering mode', () => {
      assert.ok(HELP.includes('steer'), 'HELP should mention steering');
    });
  });

  describe('SLASH_COMMANDS', () => {
    it('includes all expected commands', () => {
      const expected = ['/clear', '/cwd', '/exit', '/help', '/login', '/memory', '/model'];
      for (const cmd of expected) {
        assert.ok(SLASH_COMMANDS.includes(cmd as any), `SLASH_COMMANDS should include ${cmd}`);
      }
    });
  });

  describe('completeSlash', () => {
    it('completes a half-typed command name', () => {
      assert.equal(completeSlash('/mod'), 'el');
    });

    it('offers nothing for a name already complete', () => {
      assert.equal(completeSlash('/model'), '');
    });

    it('offers the first argument once a space is typed', () => {
      assert.equal(completeSlash('/model '), 'deep');
      assert.equal(completeSlash('/safety '), 'default');
    });

    it('completes a half-typed argument', () => {
      assert.equal(completeSlash('/model f'), 'ast');
      assert.equal(completeSlash('/safety ag'), 'entic');
      assert.equal(completeSlash('/mcp a'), 'dd');
    });

    it('leaves a trailing space after a verb that still needs a value', () => {
      assert.equal(completeSlash('/jobs k'), 'ill ');
      assert.equal(completeSlash('/mcp rem'), 'ove ');
    });

    it('offers nothing for an argument that matches none', () => {
      assert.equal(completeSlash('/model zzz'), '');
    });

    it('offers nothing for an argument already complete', () => {
      assert.equal(completeSlash('/model deep'), '');
    });

    it('stops after the first argument, where the value is a runtime name', () => {
      assert.equal(completeSlash('/jobs kill '), '');
      assert.equal(completeSlash('/mcp remove '), '');
    });

    it('offers nothing for a command that takes no fixed arguments', () => {
      assert.equal(completeSlash('/clear '), '');
    });

    it('ignores input that is not a slash command', () => {
      assert.equal(completeSlash('model de'), '');
      assert.equal(completeSlash('/'), '');
    });
  });

  // A completion that offers a word the parser rejects is worse than none, so
  // every advertised argument has to actually resolve.
  describe('SUBCOMMANDS agrees with the parser', () => {
    it('every offered argument is accepted by resolveSlashCommand', () => {
      for (const [cmd, words] of Object.entries(SUBCOMMANDS)) {
        for (const { word, operand } of words) {
          // A verb declaring an operand is only valid with one, so supply a
          // stand-in — what is being pinned is that the *word* is recognised.
          const line = operand ? `${cmd} ${word} sample` : `${cmd} ${word}`;
          const result = resolveSlashCommand(line);
          assert.notEqual(result.type, 'usage', `"${line}" should parse`);
          assert.notEqual(result.type, 'unknown', `"${line}" should parse`);
        }
      }
    });

    it('every word declaring no operand is runnable on its own', () => {
      for (const [cmd, words] of Object.entries(SUBCOMMANDS)) {
        for (const { word, operand } of words) {
          if (operand) continue;
          const result = resolveSlashCommand(`${cmd} ${word}`);
          assert.notEqual(result.type, 'usage', `"${cmd} ${word}" should need no further input`);
        }
      }
    });

    it('only names commands that exist', () => {
      for (const cmd of Object.keys(SUBCOMMANDS)) {
        assert.ok(SLASH_COMMANDS.includes(cmd as any), `${cmd} should be a real command`);
      }
    });
  });
});