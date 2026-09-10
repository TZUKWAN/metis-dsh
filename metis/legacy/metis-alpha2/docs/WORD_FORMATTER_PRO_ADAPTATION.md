# Word-Formatter-Pro 适配调研（2026-08-20）

## 结论

METIS 不嵌入 Word-Formatter-Pro 的 GUI、二进制文件或源代码。它是一个独立的 Tk 桌面应用，功能模型也不是 METIS 的项目成果/版本模型。METIS 只采用可独立实现的产品思路：明确的页边距、标题、正文、表格与图表样式策略；标题层级识别；以及在格式化前后保留可追溯版本。

截至调研日，其公开仓库根目录标注 `MIT`，并说明其格式化能力包括页面设置、标题/正文层级、段落缩进、表格处理、页码和 DOCX/TXT/Markdown 输入。因此从许可证角度可以研究其公开实现；但当前实现保持独立，以避免把第三方桌面 GUI 或其局部假设带入 METIS。

## METIS 实现边界

- `WordDocumentFormatting` 是纯粹的成果 `WordDocument` 变换：一次排版产生同一 Artifact 的新版本，而不是生成一个脱离版本树的副本。
- 自然语言入口只接受可明确映射的字体、字号、行距、对齐、首行缩进、页边距和纸张大小；无法确定的要求必须显示为未执行，不能伪称完成。
- DOCX 导入/导出使用 METIS 自己的 Word 文档模型和 OOXML 编码器。复杂宏、修订、嵌入对象与无法映射的混合 Run 格式必须保留为显式降级信息，不能无声破坏后说“保真”。
- 所有排版结果必须保存为成果版本，支持人工查看、比较、回退和 AI 协同前的草稿保护。

## 后续验证

1. 基础格式转换的模型级回归：`tests/engine/WordDocumentFormatting.test.ts`。
2. DOCX 进出闭环必须用真实 OOXML 文件、临时目录和渲染 PNG 复核。
3. 需在产品 UI 中验收：导入 → 编辑 → 排版 → 保存版本 → 导出；以及无法保真内容的可见降级提示。

## 调研来源

- https://gitee.com/cwyalpha/Word-Formatter-Pro （README 与根目录 LICENSE 标识，2026-08-20 访问）
- https://learn.microsoft.com/en-us/office/open-xml/word/working-with-paragraphs （WordprocessingML 段落属性）
- https://learn.microsoft.com/en-us/office/open-xml/word/working-with-wordprocessingml-tables （WordprocessingML 表格结构）
