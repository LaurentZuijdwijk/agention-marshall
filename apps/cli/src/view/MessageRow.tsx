import React from 'react';
import { Box, Text } from 'ink';
import { Header, STARTUP_TAGLINES } from './Banner.js';
import { MarkdownView } from './MarkdownView.js';
import { C, G } from './theme.js';
import { AssistantText } from './AssistantText.js';
import { truncate } from '../format.js';
import type { Message } from './message.js';

// ── message row ────────────────────────────────────────────────────────────────

const TOOL_RESULT_LINES = 10;

// Fixed-width parts of a safety row, so the reason can be sized to what is
// left: the two-space indent plus gutter plus its space, the "<icon> safety "
// label, and the "  •  " that precedes the judge.
const GUTTER_COLS = 4;
const SAFETY_LABEL_COLS = 9;
const SAFETY_JUDGE_COLS = 5;

/**
 * The judge, named by its model alone.
 *
 * The event carries a full `provider/vendor/model` label, which is mostly path
 * and crowds out the reasoning that is the point of the row.
 */
export function judgeLabel(model: string | undefined): string {
  return model ? model.split('/').pop() ?? '' : '';
}

/**
 * The judge's reason, cut to whatever the rest of the row leaves.
 *
 * Exported for tests: the column arithmetic is the only part here that can go
 * wrong silently, and it goes wrong invisibly — the row simply wraps, and the
 * continuation lands at column 0 having lost the gutter that marks it as
 * commentary on the call above.
 */
export function fitSafetyReason(
  reason: string,
  { judge, caller, columns }: { judge: string; caller?: string; columns: number },
): string {
  const fixed = GUTTER_COLS
    + (caller ? caller.length + 1 : 0)
    + SAFETY_LABEL_COLS
    + (judge ? judge.length + SAFETY_JUDGE_COLS : 0);
  const room = columns - fixed;
  // No room at all drops the reason rather than leaving a bare ellipsis, which
  // is what `truncate` would give back and which costs a column to say nothing.
  return room <= 0 ? '' : truncate(reason, room);
}

/**
 * A nested agent's tool arguments, cut to whatever the rest of the row leaves.
 *
 * Same arithmetic as `fitSafetyReason`, and the same failure it prevents — but
 * these rows are worse when they wrap, because the fixed part of the row is
 * *before* the content. A long shell command squeezes the columns to its left
 * until the tool name itself breaks, which is how `run_shell` under `agent2`
 * renders as "Run" above a stray "shell".
 */
export function fitToolContent(
  content: string,
  { parent, title, columns }: { parent: string; title: string; columns: number },
): string {
  // gutter + parent + space + glyph + space + title + the two spaces before content
  const fixed = GUTTER_COLS + parent.length + 1 + 2 + title.length + 2;
  const room = columns - fixed;
  return room <= 0 ? '' : truncate(content, room);
}

/**
 * Who made this call, in front of the tool it called.
 *
 * Only rendered when someone other than the coder made it: /plan and /review run
 * their own agents whose reads land at the same indent as the coder's, and
 * unlabelled they read as the coder wandering off task. The coder itself stays
 * bare — it is the default voice, and a tag on every row is just noise.
 */
function CallerTag({ caller }: { caller?: string }) {
  if (!caller) return null;
  return <Text color={C.faint}>{caller} </Text>;
}

export function MessageRow({ msg, columns = process.stdout.columns ?? 80 }: {
  msg: Message;
  /** Terminal width, for rows that size themselves to fit rather than wrap. */
  columns?: number;
}) {
  switch (msg.role) {
    case 'header':
      return msg.meta ? <Header meta={msg.meta} compact={msg.compact} tagline={msg.tagline} /> : null;

    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={C.user} bold>{G.prompt} </Text>
          <Text color={C.user} bold>{msg.content}</Text>
        </Box>
      );

    case 'assistant':
      return <AssistantText text={msg.content} />;

    case 'markdown':
      return (
        <Box flexDirection="column" marginY={1}>
          <Box>
            <Text color={C.warn} bold>{msg.title}</Text>
            {msg.note && <Text color={C.faint}>  {msg.note}</Text>}
          </Box>
          <MarkdownView text={msg.content} />
        </Box>
      );

    // A tool the *sub-agent* called: nested under the agent that owns it, dimmed,
    // and tagged with the call it belongs to — the full `context#0`, because with
    // a planner and two surveys in flight a bare `#0` names nothing.
    case 'tool':
      return msg.parent ? (
        <Box>
          <Text color={C.faint}>{G.gutter}   </Text>
          <Text color={C.faint}>{msg.parent} </Text>
          <Text color={C.tool} dimColor>{G.tool} {msg.title}</Text>
          {msg.content !== '' && (
            <Text color={C.faint}>
              {'  '}
              {fitToolContent(msg.content, {
                parent: msg.parent,
                title: msg.title ?? '',
                columns,
              })}
            </Text>
          )}
        </Box>
      ) : (
        <Box marginTop={1}>
          <CallerTag caller={msg.caller} />
          <Text color={C.tool}>{G.tool} </Text>
          <Text color={C.tool}>{msg.title}</Text>
          {msg.content !== '' && <Text color={C.muted}>  {msg.content}</Text>}
          {msg.note && <Text color={C.faint}>  {msg.note}</Text>}
        </Box>
      );

    // Safety level 3's judge, reporting on the call directly above it. Indented
    // like a tool result — it is commentary on that row, not an event of its
    // own — but with its own icon/colour per outcome so a denial (still headed
    // to the human) reads differently at a glance from a call that was cleared
    // outright.
    case 'safety': {
      const icon = msg.safetyOutcome === 'approve' ? G.ok : msg.safetyOutcome === 'deny' ? G.warn : G.pending;
      const color = msg.safetyOutcome === 'approve' ? C.ok : msg.safetyOutcome === 'deny' ? C.warn : C.muted;
      // The tool name is deliberately not repeated: this row sits directly
      // under the call it judged, which already names it.
      const judge = judgeLabel(msg.note);
      const reason = fitSafetyReason(msg.content, { judge, caller: msg.caller, columns });
      return (
        <Box>
          <Text color={C.faint}>  {G.gutter} </Text>
          <CallerTag caller={msg.caller} />
          <Text color={color}>{icon} safety </Text>
          {reason !== '' && <Text color={C.muted}>{reason}</Text>}
          {judge !== '' && <Text color={C.faint}>  {G.bullet}  {judge}</Text>}
        </Box>
      );
    }

    // The differentiator: a whole agent was handed this job. Rendered as a
    // titled delegation with its brief, so it never reads as another file op.
    case 'agent':
      return (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <CallerTag caller={msg.caller} />
            <Text color={C.accent} bold>{G.assistant} agent </Text>
            <Text color={C.accent} bold>{msg.title}</Text>
            {msg.note && (
              <Text color={msg.delegated ? C.user : C.faint}>
                {'  '}{G.steer} {msg.note}
              </Text>
            )}
          </Box>
          {msg.content !== '' && (
            <Box>
              <Text color={C.faint}>{G.gutter} </Text>
              <Text color={C.muted}>{msg.content}</Text>
            </Box>
          )}
        </Box>
      );

    case 'subagent':
      return (
        <Box>
          <Text color={C.faint}>{G.gutter}   </Text>
          <Text color={C.faint}>{msg.title} </Text>
          <Text color={msg.failed ? C.error : C.ok}>{msg.failed ? G.no : G.ok} </Text>
          <Text color={msg.failed ? C.error : C.faint}>{msg.content}</Text>
          {msg.note && <Text color={C.faint}>  {G.bullet}  {msg.note}</Text>}
        </Box>
      );

    // A background command finished. Top-level and un-indented on purpose: it is
    // the one row that can appear with no turn running and nothing above it, so
    // it has to read as an event in its own right rather than as nested output.
    case 'job':
      return (
        <Box marginTop={1}>
          <Text color={msg.failed ? C.error : C.ok}>{msg.failed ? G.no : G.ok} </Text>
          <Text color={C.tool}>background </Text>
          <Text color={C.text}>{msg.title}</Text>
          <Text color={C.muted}>  {msg.content}</Text>
          {msg.note && <Text color={C.faint}>  {G.bullet}  {msg.note}</Text>}
        </Box>
      );

    // A spawned agent finished. Same shape as `job` and for the same reason —
    // it can land with no turn running — but named for what it is: a background
    // command prints, while an agent has been changing the workspace.
    case 'spawn':
      return (
        <Box marginTop={1}>
          <Text color={msg.failed ? C.error : C.ok}>{msg.failed ? G.no : G.ok} </Text>
          <Text color={C.tool}>agent </Text>
          <Text color={C.text}>{msg.title}</Text>
          <Text color={C.muted}>  {msg.content}</Text>
          {msg.note && <Text color={C.faint}>  {G.bullet}  {msg.note}</Text>}
        </Box>
      );

    case 'tool-result': {
      const lines = msg.content.split('\n');
      const overflow = lines.length - TOOL_RESULT_LINES;
      return (
        <Box flexDirection="column">
          {lines.slice(0, TOOL_RESULT_LINES).map((line, i) => (
            <Box key={i}>
              <Text color={C.faint}>  {G.gutter} </Text>
              <Text color={C.muted}>{line}</Text>
            </Box>
          ))}
          {overflow > 0 && (
            <Box>
              <Text color={C.faint}>  {G.gutter} </Text>
              <Text color={C.faint}>… {overflow} more lines</Text>
            </Box>
          )}
        </Box>
      );
    }

    case 'info':
      return (
        <Box flexDirection="column" marginTop={1}>
          {msg.content.split('\n').map((line, i) => (
            <Box key={i}>
              <Text color={C.faint}>{i === 0 ? `${G.bullet} ` : '  '}</Text>
              <Text color={C.warn}>{line}</Text>
            </Box>
          ))}
        </Box>
      );

    case 'usage':
      return (
        <Box>
          <Text color={C.faint}>  {msg.content}</Text>
        </Box>
      );

    case 'reasoning':
      return (
        <Box flexDirection="column" marginY={1}>
          <Text color={C.thinking} bold>reasoning</Text>
          <Text color={C.thinking} italic>{msg.content}</Text>
        </Box>
      );

    case 'error':
      return (
        <Box marginTop={1}>
          <Text color={C.error} bold>{G.err} </Text>
          <Text color={C.error}>{msg.content}</Text>
        </Box>
      );
  }
}
