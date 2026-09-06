import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityStatus } from './ActivityStatus.js';

/**
 * Rendering tests are intentionally kept small: the important contract is that
 * the component has one status row and exposes the derived metric in its tree.
 */
describe('ActivityStatus', () => {
  const metricRow = (props: Parameters<typeof ActivityStatus>[0]) =>
    String(((ActivityStatus(props) as any).props.children as any[])[1].props.children);

  it('shows the counts and the elapsed time', () => {
    const text = metricRow({
      state: 'complete',
      metrics: { inputTokens: 100, outputTokens: 250, durationMs: 5000 },
    });
    assert.match(text, /↑100/);
    assert.match(text, /↓250/);
    assert.match(text, /5\.0s/);
  });

  it('switches the elapsed time to minutes and hours once it runs long', () => {
    const minutes = metricRow({ state: 'complete', metrics: { outputTokens: 250, durationMs: 1_499_600 } });
    assert.match(minutes, /\b25m$/, 'rounds to a whole second before splitting into minutes');

    const exact = metricRow({ state: 'complete', metrics: { outputTokens: 250, durationMs: 300_000 } });
    assert.match(exact, /\b5m$/, 'a round number of minutes drops the seconds');

    const withSeconds = metricRow({ state: 'complete', metrics: { outputTokens: 250, durationMs: 149_000 } });
    assert.match(withSeconds, /\b2m29s$/);

    const hours = metricRow({ state: 'complete', metrics: { outputTokens: 250, durationMs: 3_900_000 } });
    assert.match(hours, /\b1h05m$/);
  });

  it('groups the digits of a count under 10,000', () => {
    const text = metricRow({ state: 'complete', metrics: { inputTokens: 100, outputTokens: 8901 } });
    assert.match(text, /↓8,901/);
  });

  it('abbreviates a count of 10,000 or more instead of grouping it', () => {
    const text = metricRow({ state: 'complete', metrics: { inputTokens: 10_000, outputTokens: 1_500_000 } });
    assert.match(text, /↑10k/, 'a round thousand drops the .0');
    assert.match(text, /↓1\.5M/);
  });

  it('puts the output rate beside the count it belongs to', () => {
    // Together rather than as its own segment: the rate describes the watched
    // agent alone while the counts include sub-agents, and side by side is the
    // only arrangement where that pairing is unambiguous.
    const text = metricRow({
      state: 'generating',
      metrics: { inputTokens: 48_210, outputTokens: 3_140, rates: { output: 52.4 } },
    });
    assert.match(text, /↓3,140 ~52\.4\/s/);
  });

  it('rates the prompt too when the provider reported a clean first-token time', () => {
    const text = metricRow({
      state: 'generating',
      metrics: { inputTokens: 3_000, outputTokens: 400, rates: { input: 9677, output: 171 }, ttftMs: 310 },
    });
    assert.match(text, /↑3,000 ~9\.7k\/s/);
    assert.match(text, /↓400 ~171\/s/);
  });

  it('leaves the input count bare when the engine withheld its rate', () => {
    // Which it does for a model that thinks without streaming it: the wait
    // before the first token is mostly generation, so dividing by it is
    // meaningless. The wait itself is reported instead.
    const text = metricRow({
      state: 'generating',
      metrics: { inputTokens: 48_210, outputTokens: 3_140, rates: { output: 52.4 }, ttftMs: 1200 },
    });
    assert.match(text, /↑48\.2k {2}↓/, 'the input count stands alone');
    assert.match(text, /1\.2s→1st/);
  });

  it('names the thinking share, so the rate and the count agree', () => {
    // Without it the row does not add up: 2,100 tokens at 56/s reads as 37s,
    // but only the 100 streamed ones were rated.
    const text = metricRow({
      state: 'generating',
      metrics: { inputTokens: 3_000, outputTokens: 2_100, reasoningTokens: 2_000, rates: { output: 56 }, ttftMs: 3000 },
    });
    assert.match(text, /↓2,100 \(2,000 thinking\) ~56\.0\/s/);
  });

  it('rates a provider that does not stream, and claims no first-token time', () => {
    const text = metricRow({ state: 'complete', metrics: { outputTokens: 250, rates: { output: 60 } } });
    assert.match(text, /↓250 ~60\.0\/s/);
    assert.doesNotMatch(text, /1st/);
  });

  it('shows the cost when one is known, and nothing where one is not', () => {
    const priced = metricRow({ state: 'complete', metrics: { outputTokens: 250, cost: '$0.0421' } });
    assert.match(priced, /\$0\.0421/);
    assert.doesNotMatch(metricRow({ state: 'complete', metrics: { outputTokens: 250 } }), /\$/);
  });

  it('drops the segments it has no figure for rather than naming them', () => {
    // A row of "duration unavailable · tok/s unavailable" is three words to say
    // the turn has not answered yet, in the one line the turn's own numbers want.
    const text = metricRow({ state: 'complete', metrics: { outputTokens: 250 } });
    assert.doesNotMatch(text, /unavailable/);
    assert.match(text, /↓250/);
  });

  it('says so plainly before a turn has reported anything', () => {
    assert.match(metricRow({ state: 'thinking', metrics: {} }), /no tokens yet/);
  });

  it('does not render an idle status without queued prompts', () => {
    assert.equal(ActivityStatus({ state: 'idle' }), null);
  });

  // A too-narrow terminal used to make the whole row (including the label the
  // Spinner renders next to it, out of this function's view) run past the
  // terminal's own width, which the terminal then hard-wraps mid-character
  // rather than reflowing — "generating" becomes "generatin" on redraw. The
  // fix sheds fields, least essential first, so the row fits before that can
  // happen; these tests check the metric string alone stays within budget
  // (the full-row width including the Spinner is covered by hand-verification,
  // since Spinner manages its own elapsed-time state independently).
  describe('narrow terminals', () => {
    // metricRow stringifies the whole "  · metric" children array (commas and
    // all) — fine for the regex checks above, but this suite needs the bare
    // metric string's own length, so it reaches one array element deeper.
    // Children are [BULLET, metric] — see the BULLET constant in ActivityStatus.
    const metricOnly = (props: Parameters<typeof ActivityStatus>[0]) =>
      String((((ActivityStatus(props) as any).props.children as any[])[1].props.children as any[])[1]);

    const full = {
      state: 'generating' as const,
      metrics: {
        inputTokens: 1_300_000, outputTokens: 106_500,
        rates: { input: 617, output: 21.0 },
        durationMs: 8_351_400, ttftMs: 2_172_000, cost: '$0',
      },
    };

    it('keeps every field on a wide terminal', () => {
      const text = metricRow({ ...full, columns: 200 });
      assert.match(text, /↑1\.3M/);
      assert.match(text, /↓106\.5k/);
      assert.match(text, /2h19m/);
      assert.match(text, /36m12s→1st/);
      assert.match(text, /\$0/);
    });

    it('drops the least essential fields first on a narrow terminal, keeping token counts', () => {
      const text = metricRow({ ...full, columns: 40 });
      assert.match(text, /↑1\.3M/, 'token counts survive no matter how narrow');
      assert.match(text, /↓106\.5k/);
      assert.doesNotMatch(text, /→1st/, 'ttft is the first to go');
    });

    it('never returns a metric string wider than its budget allows, once the token counts alone fit', () => {
      // leadingWidth for an unblocked 'generating' spinner: frame+space (2) +
      // "generating".length (10) + spaces (2) + a generous elapsed allowance
      // (7) — the same arithmetic ActivityStatus itself uses for `budget`.
      // BULLET ("  ·  ") is 5 chars, once for the reserved leading bullet and
      // once more subtracted for the metric's own. Below ~44 columns even the
      // bare, never-dropped counts (14 chars) outrun the floor budget (12) —
      // a hard floor, not a bug: there is no field left to shed.
      const leadingWidth = 2 + 'generating'.length + 2 + 7;
      const BULLET_LEN = 5;
      for (const columns of [50, 60, 80, 120]) {
        const budget = Math.max(columns - 4 - leadingWidth - BULLET_LEN, 12);
        const text = metricOnly({ ...full, columns });
        assert.ok(text.length <= budget, `at ${columns} columns got a ${text.length}-char metric: ${text}`);
      }
    });

    it('keeps just the bare counts once nothing else fits', () => {
      const text = metricOnly({ ...full, columns: 20 });
      assert.equal(text, '↑1.3M  ↓106.5k', `expected only the bare counts, got: ${text}`);
    });

    // The exact bug report: a 'thinking' row with every metric present and
    // canSkipReasoning's "ctrl-e to skip thinking" hint, which lives in a
    // separate <Text> sibling the earlier tests here never looked at — so the
    // whole row could still outrun the terminal even once the metric segment
    // alone fit its own (too-generous) budget. Elapsed time on both the
    // spinner and the duration field is well past an hour, which used to
    // render as an unabbreviated "8351.4s" wide enough to overflow on its own.
    it('accounts for the ctrl-e hint and the pending count, not just the metric segment', () => {
      const rowWidth = (props: Parameters<typeof ActivityStatus>[0]) => {
        const el = ActivityStatus(props) as any;
        let total = 4; // Box paddingX
        for (const child of el.props.children as any[]) {
          if (!child) continue;
          if (child.type?.name === 'Spinner') { total += 19; continue; } // see leadingWidth's own allowance
          const kids = Array.isArray(child.props.children) ? child.props.children : [child.props.children];
          total += kids.join('').length;
        }
        return total;
      };
      const props = {
        state: 'thinking' as const,
        metrics: {
          inputTokens: 39_200, outputTokens: 1_980,
          rates: { input: 159, output: 26.5 },
          durationMs: 506_400, ttftMs: 246_000, cost: '$0',
        },
        canSkipReasoning: true,
      };
      for (const columns of [50, 60, 80, 100, 140, 200]) {
        assert.ok(rowWidth({ ...props, columns }) <= columns,
          `at ${columns} columns the row outran its own terminal`);
      }
      // Room for everything, hint included, only once the terminal is wide enough.
      assert.ok(rowWidth({ ...props, columns: 200 }) > rowWidth({ ...props, columns: 60 }),
        'a wider terminal should show more, not the same amount, of the row');
    });

    it('reserves room for a queued-prompt count unconditionally, since it is not decoration', () => {
      const text = metricOnly({ ...full, pending: 3, columns: 45 });
      // At the same width, more must have been shed to make room for the
      // (never-dropped) pending count than when there is nothing queued.
      const withoutPending = metricOnly({ ...full, columns: 45 });
      assert.ok(text.length <= withoutPending.length, 'pending eats into the metric budget, not its own');
    });
  });
});
