/** Shows an activity reaction and, for longer work, a threaded status card. */
import { setTimeout as delay } from 'node:timers/promises'
import { key as stableId, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'
import type { FeishuConfig } from './feishu.ts'
import { SOURCE } from './feishu-trigger.ts'

export function trackFeishuActivity(ctx: SourceContext, trigger: Trigger): void {
  const messageId = trigger.channel?.address.messageId
  if (!trigger.human || trigger.addressed !== 'mention' || !messageId) return
  ctx.state.set(KV.feishu.activity(trigger.id), { triggerId: trigger.id, messageId, cardAfter: Date.now() + 5000 })
}

function statusCard(working: boolean): string {
  const title = working ? 'Working' : '处理结束'
  return JSON.stringify({ schema: '2.0', config: { update_multi: true, width_mode: 'compact', summary: { content: title } },
    body: { padding: '8px 12px 8px 12px', elements: [{ tag: 'collapsible_panel', expanded: false,
      header: { title: { tag: 'plain_text', content: title }, width: 'auto_when_fold', icon_position: 'follow_text' },
      elements: [{ tag: 'markdown', content: working ? '这条请求正在处理。' : '这条请求的本轮处理已结束。' }] }] } })
}

/** Keeps reply and reaction IDs so cleanup can resume after a restart. */
export async function syncFeishuActivity(ctx: SourceContext, signal: AbortSignal, warn?: (error: unknown) => void): Promise<void> {
  const enabled = !!ctx.config<FeishuConfig>(SOURCE)
  for (const key of ctx.state.keys(KV.feishu.activity)) {
    if (signal.aborted) return
    const activity = ctx.state.get(key)
    if (!activity) continue
    const trigger = ctx.triggers.get(activity.triggerId)
    const processing = () => enabled && !!trigger && ctx.processing(trigger)
    const { messageId } = activity
    for (const indicator of ['reaction', 'card'] as const) {
      if (signal.aborted) return
      const previous = activity[indicator]
      const active = processing()
      if (active && previous !== undefined || !active && !previous) continue
      if (active && indicator === 'card' && Date.now() < activity.cardAfter) continue
      if (previous && (previous.retryAt ?? 0) > Date.now()) continue
      const commands = ctx.commands.withSignal(AbortSignal.any([signal, AbortSignal.timeout(5000)]))
      try {
        if (!previous) {
          const params = JSON.stringify({ message_id: messageId })
          const args = indicator === 'reaction'
            ? ['im', 'reactions', 'create', '--params', params, '--data', '{"reaction_type":{"emoji_type":"Typing"}}']
            : ['im', '+messages-reply', '--message-id', messageId, '--reply-in-thread', '--msg-type', 'interactive',
              '--content', statusCard(true), '--idempotency-key', stableId('feishu-working', messageId)]
          const response = await commands.lark<{ reaction_id?: string; message_id?: string }>(args)
          const id = indicator === 'reaction' ? response?.reaction_id : response?.message_id
          if (!id) throw new Error(`Feishu did not return the ${indicator} ID`)
          activity[indicator] = { id }
        } else {
          const args = indicator === 'reaction'
            ? ['im', 'reactions', 'delete', '--params', JSON.stringify({ message_id: messageId, reaction_id: previous.id })]
            : ['api', 'PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(previous.id)}`,
              '--data', JSON.stringify({ content: statusCard(false) })]
          await commands.lark(args)
          activity[indicator] = false
        }
      } catch (error) {
        if (signal.aborted) return
        const missing = error instanceof CliError && ([230011, 230031, 230110, 232009].includes(error.code ?? 0)
          || /(?:message|reaction).*not found/i.test(error.message))
        activity[indicator] = previous && !missing ? { ...previous, retryAt: Date.now() + 30_000 } : false
        if (!missing) warn?.(error)
      }
      ctx.state.set(key, activity)
    }
    if (!processing() && !activity.reaction && !activity.card) ctx.state.set(key, undefined)
  }
}

export async function runFeishuActivity(ctx: SourceContext, signal: AbortSignal, warn?: (error: unknown) => void): Promise<void> {
  await ctx.ready
  while (!signal.aborted && ctx.configured() && ctx.deployment.feishu) {
    await syncFeishuActivity(ctx, signal, warn)
    await delay(1000, undefined, { signal }).catch(() => {})
  }
}
