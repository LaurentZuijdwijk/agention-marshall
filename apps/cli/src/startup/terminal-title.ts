import { basename } from 'node:path';

/**
 * Save/restore the terminal's title; redirected output stays plain.
 *
 * The XTWINOPS title stack is the only way to put back a title we never got to
 * read, but plenty of terminals drop it — xterm ignores it unless
 * `allowWindowOps` is on, and tmux configurations vary — while the OSC 0 beside
 * it is honoured almost everywhere. So restore clears the title before popping:
 * where the stack works the pop wins and the original comes back, and where it
 * does not the tab is left empty for the next prompt to claim rather than
 * reading `Marshall — <project>` for the rest of the shell session.
 */
export function setTerminalTitle(
  workspaceRoot: string,
  stdout: { isTTY?: boolean; write(text: string): unknown } = process.stdout,
): () => void {
  if (!stdout.isTTY) return () => {};
  // Workspace names are untrusted terminal text, not escape sequences.
  const name = basename(workspaceRoot).replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 120);
  stdout.write(`\x1b[22;0t\x1b]0;Marshall${name ? ` — ${name}` : ''}\x07`);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    stdout.write('\x1b]0;\x07\x1b[23;0t');
  };
}
