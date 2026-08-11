import React from 'react';
import { Box, Text } from 'ink';
import { C } from './theme.js';
import { parseBlocks } from './markdown.js';
import type { Block, Span } from './markdown.js';

// ── inline spans ──────────────────────────────────────────────────────────────

function spanColor(span: Span): string | undefined {
  if (span.code) return C.code;
  if (span.link) return C.brandTo;
  if (span.dim)  return C.faint;
  return undefined; // inherit from the row
}

/**
 * Spans render as nested `<Text>` inside one parent `<Text>` so ink wraps the
 * row as a single run — separate `<Box>` children would each wrap on their own
 * and break mid-sentence.
 */
function Inline({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, i) => (
        <Text
          key={i}
          bold={span.bold}
          italic={span.italic}
          strikethrough={span.strike}
          underline={span.link}
          color={spanColor(span)}
        >
          {span.text}
        </Text>
      ))}
    </>
  );
}

// ── blocks ────────────────────────────────────────────────────────────────────

function CodeBlock({ lang, lines }: { lang: string; lines: string[] }) {
  return (
    <Box flexDirection="column">
      {lang !== '' && (
        <Box>
          <Text color={C.brandFrom}>▎</Text>
          <Text color={C.faint}> {lang}</Text>
        </Box>
      )}
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color={C.brandFrom}>▎</Text>
          <Text color={C.code}> {line}</Text>
        </Box>
      ))}
    </Box>
  );
}

function BlockRow({ block }: { block: Block }) {
  switch (block.kind) {
    case 'blank':
      return <Text> </Text>;

    case 'rule':
      return (
        <Box borderStyle="single" borderColor={C.faint}
             borderBottom={false} borderLeft={false} borderRight={false} />
      );

    case 'heading':
      return (
        <Text bold color={block.level <= 2 ? C.brandTo : C.accent}>
          <Inline spans={block.spans} />
        </Text>
      );

    case 'code':
      return <CodeBlock lang={block.lang} lines={block.lines} />;

    case 'quote':
      return (
        <Box>
          <Text color={C.faint}>▎ </Text>
          <Text color={C.muted} italic><Inline spans={block.spans} /></Text>
        </Box>
      );

    case 'item':
      return (
        <Box>
          <Text color={C.accent}>{'  '.repeat(block.indent)}{block.marker} </Text>
          <Text color={C.output}><Inline spans={block.spans} /></Text>
        </Box>
      );

    case 'para':
      return <Text color={C.output}><Inline spans={block.spans} /></Text>;
  }
}

/** Render markdown-ish text. See `markdown.ts` for what is and isn't supported. */
export function MarkdownView({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => <BlockRow key={i} block={block} />)}
    </Box>
  );
}
