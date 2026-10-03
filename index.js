/**
 * Session insight projection unit (`sessionInsight`) for the DeepSeek Harness.
 *
 * Complements the first-party `sessionStats` unit instead of duplicating it:
 * `sessionStats` answers "how long / how many", this answers "is this session
 * healthy" — tool failure rate and repeated identical tool calls.
 *
 * Fold inputs (every field below was read out of the installed package sources,
 * not guessed):
 *   - `assistant/message`  data.message.content[] blocks of `{ type:'tool-call', id, name, arguments }`
 *                          (dsh-llm/lib/types/assembler.js:100-105)
 *   - `tool/call`          data.callId (dsh-session/lib/index.js:830, invariant.js:87-89)
 *   - `tool/result`        data.message.source.callId and data.message.isError
 *                          (dsh-session/lib/types/invariant.js:101-105, lib/index.js:862)
 *   - `step/end`           one per entered step (dsh-session-stats/lib/index.js:22-30)
 *   - `turn/end`           closes the turn; clears dangling calls
 *
 * @module dsh-session-insight
 */

import { z } from 'zod';

/** Cordis plugin name (short name; used only for fiber runtime records). */
export const name = 'session-insight';

/** Without the projection registry this plugin has nothing to do, so it stays pending. */
export const inject = ['sessionProjections'];

/** The client-visible wire shape. */
const insightViewSchema = z
  .object({
    steps: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    toolFailures: z.number().int().nonnegative(),
    repeatedCalls: z.number().int().nonnegative(),
    failureRate: z.number().min(0).max(1),
    health: z.enum(['good', 'watch', 'poor']),
  })
  .strict();

/**
 * The fold state: the visible counters plus the bookkeeping the counters need.
 * `view` is cached in the state on purpose — the registry compares consecutive
 * raw `wire.view` results with `Object.is`, so carrying the previous view
 * forward keeps internal-only state changes (pending-call bookkeeping) from
 * publishing a change the client cannot see.
 */
const insightStateSchema = z
  .object({
    steps: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    toolFailures: z.number().int().nonnegative(),
    repeatedCalls: z.number().int().nonnegative(),
    lastSignature: z.string().nullable(),
    pending: z.record(z.string(), z.object({ name: z.string(), args: z.string() })),
    view: insightViewSchema,
  })
  .strict();

/**
 * Derive the client-visible view from the fold state.
 * @param state - the current fold state.
 * @returns a fresh wire value.
 */
function deriveView(state) {
  const rate = state.toolCalls === 0 ? 0 : state.toolFailures / state.toolCalls;
  const failureRate = Math.round(rate * 1000) / 1000;
  const health =
    state.toolFailures === 0 && state.repeatedCalls === 0
      ? 'good'
      : (state.toolFailures >= 3 && rate >= 0.5) || state.repeatedCalls >= 3
        ? 'poor'
        : 'watch';
  return {
    steps: state.steps,
    toolCalls: state.toolCalls,
    toolFailures: state.toolFailures,
    repeatedCalls: state.repeatedCalls,
    failureRate,
    health,
  };
}

/**
 * Build a state whose visible counters changed: recompute and cache the view.
 * @param state - the next fold state, without a refreshed `view`.
 * @returns the same object with `view` replaced by a fresh value.
 */
function publish(state) {
  return { ...state, view: deriveView(state) };
}

/** The `sessionInsight` unit registered on `ctx.sessionProjections`. */
const insightProjectionDefinition = {
  key: 'sessionInsight',
  stateVersion: 1,
  stateSchema: insightStateSchema,
  init: () => ({
    steps: 0,
    toolCalls: 0,
    toolFailures: 0,
    repeatedCalls: 0,
    lastSignature: null,
    pending: {},
    view: {
      steps: 0,
      toolCalls: 0,
      toolFailures: 0,
      repeatedCalls: 0,
      failureRate: 0,
      health: 'good',
    },
  }),
  apply: (state, event) => {
    switch (event.type) {
      // Record the call head so `tool/call` can name it and `tool/result` can
      // attribute a failure to a tool. Pending entries are bookkeeping only.
      case 'assistant/message': {
        const content = event.data?.message?.content;
        if (!Array.isArray(content)) return state;
        const calls = content.filter((block) => block?.type === 'tool-call');
        if (calls.length === 0) return state;
        const pending = { ...state.pending };
        for (const call of calls) {
          pending[call.id] = {
            name: typeof call.name === 'string' ? call.name : 'unknown',
            args: typeof call.arguments === 'string' ? call.arguments : '',
          };
        }
        return { ...state, pending };
      }
      case 'tool/call': {
        const callId = event.data?.callId;
        const call = typeof callId === 'string' ? state.pending[callId] : undefined;
        // A repeated identical call is the classic agent loop signature.
        const signature = call === undefined ? null : `${call.name}\u0000${call.args}`;
        const repeated = signature !== null && signature === state.lastSignature;
        return publish({
          ...state,
          toolCalls: state.toolCalls + 1,
          repeatedCalls: state.repeatedCalls + (repeated ? 1 : 0),
          lastSignature: signature,
        });
      }
      case 'tool/result': {
        const message = event.data?.message;
        const callId = message?.source?.callId;
        if (typeof callId !== 'string') return state;
        const pending = Object.hasOwn(state.pending, callId)
          ? Object.fromEntries(Object.entries(state.pending).filter(([id]) => id !== callId))
          : state.pending;
        if (message?.isError !== true) {
          // Success: drop the bookkeeping. No visible counter moved, so the
          // cached view reference is carried forward and nothing is published.
          if (pending === state.pending) return state;
          return { ...state, pending };
        }
        return publish({
          ...state,
          toolFailures: state.toolFailures + 1,
          pending,
        });
      }
      case 'step/end':
        return publish({ ...state, steps: state.steps + 1 });
      case 'turn/end':
        return Object.keys(state.pending).length === 0 ? state : { ...state, pending: {} };
      default:
        // Unrelated events must return the same reference: that is the
        // registry's first Object.is gate and the whole point of the contract.
        return state;
    }
  },
  wire: {
    viewSchema: insightViewSchema,
    view: (state) => state.view,
  },
};

/**
 * Register the `sessionInsight` unit. Registration is an effect on this
 * plugin's fiber, so unloading the plugin removes the key and its cells.
 * @param ctx - registrant context carrying the session-projection registry.
 */
export function apply(ctx) {
  ctx.sessionProjections.register(insightProjectionDefinition);
}
