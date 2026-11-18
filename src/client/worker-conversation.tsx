/** Presents Feishu request relays and reported answers in the DSH worker transcript. */
import { useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { T } from './text.ts'

const REQUEST = 'dsh-superagent-worker-request'
const ANSWER = 'dsh-superagent-worker-answer'

type RecordValue = Record<string, unknown>
const object = (value: unknown): RecordValue | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
const nonempty = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined
function parse(value: unknown): RecordValue | undefined {
  if (typeof value !== 'string') return object(value)
  try { return object(JSON.parse(value)) } catch { return undefined }
}
function textBlocks(value: unknown): string {
  return Array.isArray(value) ? value.flatMap(item => {
    const block = object(item)
    return (block?.type === 'text' || block?.kind === 'text') && typeof block.text === 'string' ? [block.text] : []
  }).join('\n') : ''
}

// These client extension seats are available in rc.3, but outside the prototype's alpha SDK.
type Event = { type: string; seq: number; surfaceOp?: string; data: RecordValue }
type Match = { event: Event; location: unknown }
type ContextState<State> = { key: string; id: string; state?: State; start?: Match }
type Identity = { id: string; role: 'start' | 'update'; exclusive?: true }
type Renderer = (props: never) => ReactNode
type Observable<Value> = { subscribe: (notify: () => void) => () => void; getSnapshot: () => Value | undefined }
type Answer = { markdown: string; historical: boolean }
type Turn = {
  data: { source: (key: string) => Observable<Answer> }
  steps: readonly { data: { get: (key: string) => unknown } }[]
}
type Request = { text: string; title?: string; url?: string; raw: RecordValue }

function safeLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') return value
  } catch { /* Leave malformed links in the details only. */ }
}
function requestOf(event: Event): Request | undefined {
  if (event.type !== 'user/message' || event.surfaceOp !== 'append') return undefined
  const source = object(event.data.source)
  if (source?.kind !== 'dsh-superagent' || source.form !== 'relay') return undefined
  const raw = parse(textBlocks(event.data.content))
  if (!raw || raw.kind !== undefined) return undefined
  const trigger = object(raw.trigger) ?? raw
  const body = nonempty(trigger.text), thread = nonempty(trigger.thread)
  if (!body || !nonempty(trigger.trigger_id) || !thread?.startsWith('feishu:')) return undefined
  return { text: body, title: nonempty(raw.title), url: safeLink(trigger.source_url), raw }
}
const requestDefinition = {
  kind: REQUEST,
  target: 'chat',
  match: { 'user/message': (event: Event): Identity | null => requestOf(event)
    ? { id: String(event.data.id ?? event.seq), role: 'start', exclusive: true } : null },
  start: (_context: unknown, match: Match) => requestOf(match.event),
  update: (context: ContextState<Request>) => context.state,
  buildViewNode: (context: ContextState<Request>) => context.start && context.state ? {
    key: context.key, id: context.id, kind: REQUEST, target: 'chat',
    anchorSeq: context.start.event.seq, location: context.start.location,
    groupTree: context.state.raw.trigger ? 'input' : 'turn', visibility: 'visible', data: context.state,
  } : null,
}

function reportedBody(event: Event): Answer | undefined {
  if (event.data.name !== 'orchestrator_report') return undefined
  const args = parse(event.data.arguments)
  const markdown = nonempty(args?.reply_markdown)
  if (markdown) return { markdown, historical: false }
  const summary = nonempty(args?.summary)
  return summary && args?.state === 'ready' ? { markdown: summary, historical: true } : undefined
}
function acceptedCall(event: Event): { id: string; direct: boolean } | undefined {
  const message = object(event.data.message)
  if (!message || message.isError) return undefined
  const result = parse(textBlocks(message.content)), id = nonempty(message.toolCallId)
  if (id && result?.reported === true) return { id, direct: result.notification === 'direct' }
}
type ReportState = { turn: number; feishuHistory: boolean; pending: ReadonlyMap<string, Answer>; answer?: Answer }
function advanceReport(state: ReportState, event: Event): ReportState {
  if (event.type === 'tool/call') {
    const callId = nonempty(event.data.callId), answer = reportedBody(event)
    if (!callId || !answer || (answer.historical && !state.feishuHistory)) return state
    return { ...state, pending: new Map(state.pending).set(callId, answer) }
  }
  const call = acceptedCall(event), answer = call && state.pending.get(call.id)
  if (!call || !answer || (!answer.historical && !call.direct)) return state
  const pending = new Map(state.pending)
  pending.delete(call.id)
  return { ...state, pending, answer }
}
const answerDefinition = {
  kind: ANSWER,
  match: {
    'tool/call': (event: Event): Identity | null => typeof event.data.turn === 'number' && reportedBody(event)
      ? { id: String(event.data.turn), role: 'start' } : null,
    'tool/result': (event: Event): Identity | null => typeof event.data.turn === 'number' && acceptedCall(event)
      ? { id: String(event.data.turn), role: 'update' } : null,
  },
  // The accepted direct reply identifies new Feishu answers even when earlier turns haven't been loaded.
  start: (_context: unknown, match: Match, reader: { previous: (kind: string) => unknown }) =>
    advanceReport({ turn: Number(match.event.data.turn), feishuHistory: !!reader.previous(REQUEST), pending: new Map() }, match.event),
  update: (context: ContextState<ReportState> & { state: ReportState }, match: Match) => advanceReport(context.state, match.event),
  buildLocationData: ({ state }: ContextState<ReportState>, scope: string) => scope === 'turn' && state?.answer
    ? { kind: 'turn', turn: state.turn, key: ANSWER, value: state.answer } : null,
}

function RequestCard({ node, t, cwd }: { node: { data: Request }; t: T; cwd?: string }) {
  const { text, title, url, raw } = node.data
  const project = cwd?.split(/[\\/]/).filter(Boolean).at(-1)
  return <section aria-label={t('workerRequest')} style={{
    background: 'var(--dsw-alias-turn-trigger-bg, var(--dsw-alias-markdown-code-block))',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 'var(--dsw-radius-xl, 14px)',
    padding: '12px 16px', marginBlock: '8px', color: 'var(--dsw-alias-label-primary)',
  }}>
    <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 12px', marginBottom: 6 }}>
      <strong>{title ?? t('workerRequest')}</strong>
      {project && <span title={cwd} style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>{project}</span>}
      {url && <a href={url} target="_blank" rel="noopener noreferrer" style={{ marginInlineStart: 'auto', fontSize: 12 }}>{t('workerRequestSource')}</a>}
    </header>
    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</div>
    <details style={{ marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
      <summary style={{ cursor: 'pointer' }}>{t('workerRequestDetails')}</summary>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(raw, null, 2)}</pre>
    </details>
  </section>
}

function AnswerCard({ turn, t, renderFactorySlot }: { turn: Turn; t: T;
  renderFactorySlot?: (name: string, props: RecordValue) => ReactNode }) {
  const source = turn.data.source(ANSWER)
  const answer = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const closing = object(turn.steps.at(-1)?.data.get('assistant-step'))
  const finalText = closing?.finalNode ? textBlocks(closing.blocks).trim() : ''
  if (!answer || (finalText && (answer.historical || finalText === answer.markdown.trim()))) return null
  const label = t(answer.historical ? 'workerReport' : 'workerReply')
  return <section aria-label={label} style={{ marginBlock: '10px 6px', minWidth: 0 }}>
    <div style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontWeight: 500, marginBottom: 5 }}>{label}</div>
    {renderFactorySlot?.('conversation.chat.reasoning.content', { text: answer.markdown, running: false })
      ?? <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{answer.markdown}</div>}
  </section>
}

export function installWorkerConversation(ctx: Context, locale: string): void {
  ctx.inject(['uiConversation'], scope => {
    const conversation = scope.get('uiConversation') as { events: {
      register: (definition: typeof requestDefinition | typeof answerDefinition) => () => void
    } }
    scope.effect(() => conversation.events.register(requestDefinition), 'dsh-superagent: workspace task')
    scope.effect(() => conversation.events.register(answerDefinition), 'dsh-superagent: workspace reply')
    const slots = scope.slots as unknown as {
      inject: (name: string, register: () => () => void) => void
      register: (options: { name: string; locale: string; key?: string; id?: string }, renderer: Renderer) => () => void
    }
    slots.inject('conversation.chat.node', () => slots.register({ name: 'conversation.chat.node', key: REQUEST, locale }, RequestCard))
    slots.inject('conversation.chat.turnTail', () => slots.register({ name: 'conversation.chat.turnTail', id: ANSWER, locale }, AnswerCard))
  })
}
