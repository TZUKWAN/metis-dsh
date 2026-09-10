import io

p = 'electron/ScenarioWorkflowService.ts'
s = io.open(p, encoding='utf-8').read()

# finalCard 同样结构化：正文人话 + metadata.stepCard
old = """  const completedMessage = [
    finalArtifactName
      ? `【场景工作流已完成】最终成果（约 ${finalCard.chars.toLocaleString('en-US')} 字符）已保存为生成物「${finalArtifactName}」${projectId ? '，并自动写入本项目成果库（科研产出分类）' : ''}。`
      : `【场景工作流已完成】最终成果已生成（生成物注册失败，请检查存储）。`,
    '',
    '```metis-step-card',
    JSON.stringify(finalCard),
    '```',
  ].join('\\n');
  try { store.appendMessage(sessionId, 'assistant', completedMessage); } catch { /* 摘要落库失败不阻塞 turn 返回 */ }"""
new = """  const completedMessageText = finalArtifactName
    ? `场景工作流已完成。最终成果（约 ${finalCard.chars.toLocaleString('en-US')} 字符）已保存为生成物「${finalArtifactName}」${projectId ? '，并自动写入本项目成果库（科研产出分类）' : ''}。`
    : '场景工作流已完成。最终成果已生成（生成物注册失败，请检查存储）。';
  try {
    store.appendMessage(sessionId, 'assistant', completedMessageText, { metadata: { stepCard: finalCard } });
  } catch { /* 摘要落库失败不阻塞 turn 返回 */ }"""
assert old in s, 'finalCard anchor'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('finalCard structured')
