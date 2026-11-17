import type { ComponentType, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { installWorkerConversation } from '../src/client/worker-conversation.tsx'
import { zh } from '../src/client/locales.ts'

type Event = { type: string; surfaceOp?: string; data: Record<string, unknown>; seq: number }
type Definition = {
  kind: string
  match: Record<string, (event: Event) => unknown>
  start: (context: unknown, match: { event: Event }, reader: { previous: (kind: string) => unknown }) => unknown
  update: (context: { state: unknown }, match: { event: Event }) => unknown
  buildViewNode?: (context: unknown) => { data: unknown }
  buildLocationData?: (context: { state: unknown }, scope: string) => { key: string; value: unknown } | null
}
function fixture() {
  const definitions: Definition[] = []
  const slots: ComponentType<Record<string, unknown>>[] = []
  installWorkerConversation({
    get: () => ({ events: { register: (definition: Definition) => definitions.push(definition) } }),
    effect: (callback: () => void) => callback(),
    slots: { inject: (_name: string, register: () => void) => register(),
      register: (_options: unknown, render: ComponentType<Record<string, unknown>>) => slots.push(render) },
  } as never, 'dshSuperagent')
  return { request: definitions[0]!, answer: definitions[1]!, Request: slots[0]!, Answer: slots[1]! }
}
const t = (key: keyof typeof zh) => zh[key]
const block = (text: string) => [{ type: 'text', text }]
const reader = (hasFeishu: boolean) => ({ previous: () => hasFeishu ? {} : undefined })

it('shows Feishu source prose before the raw dispatch details and leaves unrelated notices with DSH', () => {
  const { request, Request } = fixture()
  const source = { kind: 'dsh-superagent', form: 'relay' }
  const trigger = { trigger_id: 'tr-1', thread: 'feishu:group:msg', text: '查一下 **订单**\n给我结论',
    source_url: 'https://applink.feishu.cn/client/chat/open?openChatId=group' }
  const event: Event = { type: 'user/message', surfaceOp: 'append', seq: 2, data: { id: 'event', source,
    content: block(JSON.stringify({ ticket_id: 't1', title: '查询订单', trigger })) } }
  const match = request.match['user/message']!
  expect(match(event)).toEqual({ id: 'event', role: 'start', exclusive: true })
  const start = { event, location: { kind: 'step' } }
  const node = request.buildViewNode!({ key: 'event', id: 'event', start, state: request.start(null, start, reader(false)) })
  expect(node).toMatchObject({ groupTree: 'input', visibility: 'visible' })
  const markup = renderToStaticMarkup(<Request node={node} cwd="/some/project" t={t} />)
  expect(markup).toContain('查询订单')
  expect(markup).toContain('href="https://applink.feishu.cn/client/chat/open?openChatId=group"')
  expect(markup).toContain('project')
  const [visible, details] = markup.split('<details')
  expect(visible).toContain('查一下 **订单**\n给我结论')
  expect(visible).not.toContain('tr-1')
  expect(details).toContain('tr-1')
  expect(details).not.toContain(' open=""')
  expect(match({ ...event, data: { ...event.data, source: { kind: 'user' } } })).toBeNull()
  expect(match({ ...event, data: { ...event.data, content: block(JSON.stringify({ kind: 'worker_report', trigger })) } })).toBeNull()
  expect(match({ ...event, data: { ...event.data, content: block(JSON.stringify({ ...trigger, thread: 'github:owner/repo:25' })) } })).toBeNull()
})

function report({ answer: definition }: ReturnType<typeof fixture>, args: { reply_markdown?: string; summary: string; state: string },
  { accepted = true, isError = false, feishu = true, notification = args.reply_markdown ? 'direct' : 'orchestrator' } = {}) {
  const call: Event = { type: 'tool/call', seq: 47, data: { turn: 1, callId: 'call-1', name: 'orchestrator_report',
    arguments: JSON.stringify(args) } }
  const result: Event = { type: 'tool/result', seq: 48, data: { turn: 1, message: { toolCallId: 'call-1', isError,
    content: block(JSON.stringify({ reported: accepted, notification })) } } }
  expect(definition.match['tool/call']!(call)).toMatchObject({ id: '1', role: 'start' })
  const state = definition.start(null, { event: call }, reader(feishu))
  expect(definition.buildLocationData!({ state }, 'turn')).toBeNull()
  return definition.buildLocationData!({ state: definition.update({ state }, { event: result }) }, 'turn')
}
function turn(value: unknown, final = '') {
  return {
    data: { source: () => ({ subscribe: () => () => {}, getSnapshot: () => value }) },
    steps: [{ data: { get: () => ({ finalNode: {}, blocks: [{ kind: 'text', text: final }] }) } }],
  }
}

it('shows the original screenshot-style successful tool-only report when a legacy worker left its final chat empty', () => {
  const view = fixture()
  const input = { state: 'ready', summary: '正式回复未按时发出。\n证据见之前的收悉确认。' }
  const data = report(view, input)
  expect(data).toMatchObject({ value: { markdown: input.summary, historical: true } })
  expect(renderToStaticMarkup(<view.Answer t={t} turn={turn(data?.value)} />)).toContain('执行报告')
  expect(renderToStaticMarkup(<view.Answer t={t} turn={turn(data?.value)} />)).toContain(input.summary)
  expect(renderToStaticMarkup(<view.Answer t={t} turn={turn(data?.value, '已有可见正文')} />)).toBe('')
  expect(report(view, input, { feishu: false })).toBeNull()
})

it('renders accepted public Markdown outside the work log with no duplicate final text or rejected report', () => {
  const view = fixture()
  const args = { state: 'ready', summary: '内部状态和报告', reply_markdown: '## 结论\n**有结果**' }
  const data = report(view, args)
  expect(data).toMatchObject({ value: { markdown: args.reply_markdown, historical: false } })
  const markdown = vi.fn((_name: string, _props: unknown): ReactNode => <h2>结论</h2>)
  const shown = renderToStaticMarkup(<view.Answer t={t} turn={turn(data?.value)} renderFactorySlot={markdown} />)
  expect(shown).toContain('执行器回复')
  expect(shown).not.toContain(args.summary)
  expect(markdown).toHaveBeenCalledExactlyOnceWith('conversation.chat.reasoning.content', { text: args.reply_markdown, running: false })
  expect(renderToStaticMarkup(<view.Answer t={t} turn={turn(data?.value, args.reply_markdown)} />)).toBe('')
  expect(report(view, args, { isError: true })).toBeNull()
  expect(report(view, args, { accepted: false })).toBeNull()
  expect(report(view, args, { notification: 'orchestrator' })).toBeNull()
  expect(report(view, args, { feishu: false })).toEqual(data)
})
