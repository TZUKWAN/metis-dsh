import io

p = 'src/pages/ChatPage.tsx'
s = io.open(p, encoding='utf-8').read()

# 恢复处：metadata.stepCard（新消息）→ 走 ScenarioStepCard 渲染通道
old = """            return {
              role: item.role,
              content: item.content,
              timestamp: now(),
              ...(run ? { run } : {}),
              // O8: citations persist on message metadata; rehydrate so chips
              // survive reload, not just the live turn.
              ...(extractCitations(metadata).length > 0 ? { citations: extractCitations(metadata) } : {}),
            };
          }"""
new = """            const stepCard = metadata?.stepCard;
            // T3 全局对话体验重构：新消息的 stepCard 在 metadata（结构化协议），
            // content 已是人话摘要；渲染经 __STEP_CARD__ 前缀走 ScenarioStepCard，
            // 与历史围栏消息同一渲染出口，但不再生成 Markdown 围栏协议。
            const content = stepCard && typeof stepCard === 'object'
              ? `__STEP_CARD__${JSON.stringify(stepCard)}`
              : item.content;
            return {
              role: item.role,
              content,
              timestamp: now(),
              ...(run ? { run } : {}),
              // O8: citations persist on message metadata; rehydrate so chips
              // survive reload, not just the live turn.
              ...(extractCitations(metadata).length > 0 ? { citations: extractCitations(metadata) } : {}),
            };
          }"""
assert old in s, 'rehydrate anchor'
s = s.replace(old, new)

# 渲染层：MarkdownContent/ChatMessageItem 渲染 content 时拦截 __STEP_CARD__ 前缀
old_render = "function createChatCodeComponent(streaming: boolean): Components['code'] {"
assert old_render in s
helper = """/** T3：metadata.stepCard 消息的渲染协议（非 Markdown 围栏；content 前缀承载）。 */
function parseStepCardPrefix(content: string): ScenarioStepCard | null {
  if (!content.startsWith('__STEP_CARD__')) return null;
  try {
    const value = JSON.parse(content.slice('__STEP_CARD__'.length)) as ScenarioStepCard;
    return value && typeof value === 'object' && typeof value.runId === 'string' ? value : null;
  } catch {
    return null;
  }
}

function createChatCodeComponent(streaming: boolean): Components['code'] {"""
s = s.replace(old_render, helper, 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('rehydrate + prefix helper done')
