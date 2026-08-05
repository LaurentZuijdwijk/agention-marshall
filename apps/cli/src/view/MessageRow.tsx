import React from 'react';
import { Box, Text } from 'ink';
import { Header } from './Banner.js';
import { Markdown } from './Markdown.js';
import { C, G } from './theme.js';
import { AssistantText } from './AssistantText.js';
import type { Message } from './message.js';

// ── message row ────────────────────────────────────────────────────────────────

const TOOL_RESULT_LINES = 10;

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

export function MessageRow({ msg }: { msg: Message }) {
  switch (msg.role) {
    case 'header':
      return msg.meta ? <Header meta={msg.meta} compact={msg.compact} /> : null;

    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={C.user} bold>{G.prompt} </Text>
          <Text color={C.text} bold>{msg.content}</Text>
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
          <Markdown text={msg.content} />
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
          {msg.content !== '' && <Text color={C.faint}>  {msg.content}</Text>}
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
          <Text color={C.faint} bold>reasoning</Text>
          <Text color={C.faint} italic>{msg.content}</Text>
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
