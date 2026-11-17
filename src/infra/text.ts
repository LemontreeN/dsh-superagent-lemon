/** Word counting and string formatting utilities for IM message limits and templates. */
const words = new Intl.Segmenter('zh', { granularity: 'word' })
export const IM_WORDS = 100
export const NOTE_WORDS = 30
export const FEISHU_WORKER_MARKDOWN_BYTES = 16 * 1024
/** Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation. */
export function wordCount(text: string): number {
  let count = 0
  for (const segment of words.segment(text)) if (segment.isWordLike) count++
  return count
}
/** Validates that an outgoing IM Markdown message does not exceed `IM_WORDS` (link labels and URLs both count toward the limit). */
export function checkedImText(text: string): string {
  const count = wordCount(text)
  if (count > IM_WORDS) throw new Error(`IM message has ${count} words; maximum is ${IM_WORDS}. Rewrite as a short high-level update. Do not split it into multiple messages.`)
  return text
}
/** Encode the worker's Markdown as native Feishu rich text without CLI rewriting or image uploads. */
export function feishuWorkerContent(markdown: string): string {
  if (!markdown.trim()) throw new Error('Provide the Markdown reply you want the requester to receive')
  if (Buffer.byteLength(markdown, 'utf8') > FEISHU_WORKER_MARKDOWN_BYTES) {
    throw new Error('Feishu reply_markdown may use at most 16 KiB of UTF-8. Keep the full answer in the project and include the key results and a reference here.')
  }
  const content = JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: markdown }]] } })
  // Feishu's 30 KB request limit includes the escaped content string and the rest of the envelope.
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > 28_000) {
    throw new Error('The formatted Feishu reply is too large. Shorten detailed code or outputs and point to their full location in the project.')
  }
  return content
}
export const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
/** Case-insensitive comparison for GitHub logins and repository names. */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
