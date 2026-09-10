import io

src = io.open('src/components/ContentCharterSection.tsx', encoding='utf-8').read()

# 组件名
src = src.replace('export default function ContentCharterSection() {',
                  'export default function ContentCharterPage() {')

# 外层容器改页面布局
old = '<div className="settings-group" data-testid="content-charter-section">'
new = '<div className="content-charter-page" data-testid="content-charter-page">'
assert old in src
src = src.replace(old, new)

# 页面标题头插在容器开头之后
marker = new + '\n'
head = marker + '''      <header className="content-charter-page__head">
        <h2>内容规范</h2>
        <p>跨场景通用的表达规范层：场景管「做什么」（步骤与流程），内容规范管「产出长什么样、什么质量」。支持多套并存——例如理论阐释一套、实证研究一套，一键切换激活，所有场景与对话即时生效。</p>
      </header>
'''
src = src.replace(marker, head, 1)

# CSS import
src = src.replace("import { useCallback, useEffect, useState } from 'react';",
                  "import { useCallback, useEffect, useState } from 'react';\nimport './ContentCharterPage.css';")

io.open('src/pages/ContentCharterPage.tsx', 'w', encoding='utf-8', newline='\n').write(src)
print('ContentCharterPage created')
