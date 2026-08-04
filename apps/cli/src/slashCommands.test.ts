import { describe, it, expect } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSlashCommand, HELP, SLASH_COMMANDS } from './slashCommands.js';

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

    it('returns stream for /stream', () => {
      const result = resolveSlashCommand('/stream');
      assert.equal(result.type, 'stream');
    });

    it('returns tokens for /tokens', () => {
      const result = resolveSlashCommand('/tokens');
      assert.equal(result.type, 'tokens');
    });

    it('returns plan with args for /plan <task>', () => {
      const result = resolveSlashCommand('/plan add a login form');
      assert.equal(result.type, 'plan');
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
});
