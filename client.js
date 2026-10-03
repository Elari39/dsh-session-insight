/**
 * Browser half of `dsh-session-insight`: a read-only status strip above the
 * composer, rendered from the host's `sessionInsight` projection.
 *
 * Verified facts this file depends on:
 *   - The browser module table hands out React via `require('react')`
 *     (official template: dsh-agent-preset/skills/cordis-plugin-development/
 *     templates/decoration/client.js:5).
 *   - A client module registers itself with `window.__ModuleLoader__.load({ id, factory })`
 *     and the id equals the package name
 *     (official: dsh-client-ui-goal/lib/client.js:1-3).
 *   - `conversation.input.dock` is declared `{ kind: 'list', scope: 'session' }`
 *     (dsh-client-ui-conversation/lib/client.js:18167-18170).
 *   - The session scope adapter contributes `keyedHooks: { projection: (key) =>
 *     binding.session.projections.faceOf(key) }` (dsh-client-ui-session/lib/client.js:127);
 *     the renderer turns every declared hook source into a `use<Name>` prop
 *     (dsh-client-ui-renderer/lib/client.js:648-654, 703-746), which is why an
 *     entry component receives `useProjection(key, selector?)` — exactly how the
 *     first-party goal dock consumes it (dsh-client-ui-goal/lib/client.js:372-373).
 *
 * Deliberately imports nothing but React: third-party UI plugins must not
 * `require` any `@deepseek-ai/dsh-client-ui-*` package, because one throwing
 * component takes down the whole slot entry.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-insight',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'sessionInsight';

    /** Health accent colours; artwork may use its own palette. */
    const HEALTH_COLOR = {
      good: '#3fb950',
      watch: '#d29922',
      poor: '#f85149',
    };

    /**
     * Below this many dispatched calls the strip shows the raw fraction
     * (`1/6`) rather than a percentage.
     *
     * A percentage hides its own denominator: `8.3%` reads identically whether it
     * came from 1/12 or 1000/12000, and early in a session the ratio swings hard
     * enough that a decimal invites overreaction. The fraction is exact, needs no
     * statistical inference, and carries its sample size in plain sight.
     */
    const SMALL_SAMPLE_CALLS = 10;

    /**
     * Format the failure count for the strip.
     *
     * Raw fraction while the sample is small; one decimal once it is large enough
     * that a percentage reads better than a fraction; an em dash before anything
     * has run — never a misleading `0%`.
     *
     * @param failures - failed tool results.
     * @param calls - dispatched tool calls.
     * @returns the display string.
     */
    function formatRate(failures, calls) {
      if (calls === 0) return '\u2014';
      if (calls < SMALL_SAMPLE_CALLS) return `${failures}/${calls}`;
      return `${((failures / calls) * 100).toFixed(1)}%`;
    }

    /**
     * Translate through the locale seat when it is present.
     * @param t - the locale seat prop, or undefined when the entry declares no namespace.
     * @param key - dictionary key.
     * @param fallback - English text used when no seat is available.
     * @returns the display string.
     */
    function text(t, key, fallback) {
      return typeof t === 'function' ? t(key) : fallback;
    }

    /** One `label value` pair in the strip. */
    function Stat({ label, value, tone }) {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'baseline', gap: 4 } },
        h('span', { style: { opacity: 0.6 } }, label),
        h('span', { style: { fontVariantNumeric: 'tabular-nums', color: tone } }, value),
      );
    }

    /**
     * The strip body. Split from the entry component so the projection hook is
     * only ever called on a component that actually mounted with a usable
     * `useProjection` prop — a stable condition per slot entry.
     */
    function InsightBody({ useProjection, t }) {
      const insight = useProjection('sessionInsight');
      if (insight === undefined || insight === null) return null;

      const accent = HEALTH_COLOR[insight.health] ?? HEALTH_COLOR.good;
      // Computed from the raw counts rather than the pre-rounded `failureRate`
      // so the display keeps full precision before formatting.
      const rate = formatRate(insight.toolFailures, insight.toolCalls);

      return h(
        'div',
        {
          'data-session-insight': insight.health,
          role: 'status',
          'aria-label': text(t, 'aria', 'Session insight'),
          style: {
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '4px 14px',
            fontSize: 12,
            lineHeight: '18px',
            // Only theme tokens the installed theme actually publishes are used.
            color: 'var(--dsw-alias-label-primary)',
            userSelect: 'none',
            // Align with the composer. The dock slot is the full-width composer
            // stack, so a bare block hugs the left edge; the first-party todo dock
            // in this same slot sizes itself with these composer tokens plus
            // `margin: 0 auto` instead (TodoPanel root,
            // dsh-client-ui-conversation/lib/client.js:17620-17633).
            boxSizing: 'border-box',
            flex: 'none',
            width:
              'calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))',
            maxWidth:
              'calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))',
            margin: '0 auto',
            padding: '2px 12px 4px',
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: accent,
            flex: '0 0 auto',
          },
        }),
        h(
          'span',
          { style: { fontWeight: 500 } },
          text(t, `health.${insight.health}`, insight.health),
        ),
        h(Stat, { label: text(t, 'steps', 'steps'), value: insight.steps }),
        h(Stat, { label: text(t, 'tools', 'tools'), value: insight.toolCalls }),
        h(Stat, {
          label: text(t, 'failures', 'failed'),
          value: insight.toolFailures,
          tone: insight.toolFailures > 0 ? HEALTH_COLOR.poor : undefined,
        }),
        h(Stat, {
          label: text(t, 'repeats', 'repeats'),
          value: insight.repeatedCalls,
          tone: insight.repeatedCalls > 0 ? HEALTH_COLOR.watch : undefined,
        }),
        h(Stat, { label: text(t, 'rate', 'fail rate'), value: rate }),
      );
    }

    /**
     * Entry component. Every session-scoped slot entry receives the session
     * standard kit, which includes `useProjection`; guard anyway so an
     * unexpected slot scope degrades to nothing instead of crashing the slot.
     */
    function InsightCard(props) {
      if (typeof props.useProjection !== 'function') return null;
      return h(InsightBody, { useProjection: props.useProjection, t: props.t });
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              en: {
                aria: 'Session insight',
                'health.good': 'healthy',
                'health.watch': 'watch',
                'health.poor': 'degraded',
                steps: 'steps',
                tools: 'tools',
                failures: 'failed',
                repeats: 'repeats',
                rate: 'fail rate',
              },
              zh: {
                aria: '会话健康度',
                'health.good': '健康',
                'health.watch': '留意',
                'health.poor': '异常',
                steps: '步数',
                tools: '工具',
                failures: '失败',
                repeats: '重复',
                rate: '失败率',
              },
            }),
          'session-insight: dictionaries',
        );
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'session-insight',
              order: 30,
              locale: NS,
            },
            InsightCard,
          ),
        );
      },
    };
  },
});
