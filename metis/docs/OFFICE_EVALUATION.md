# Office 能力迁移评估（Phase 22 / T22-001~016）

> 结论：**DEFER（延期，不迁入当前插件家族）**。依据任务清单 22.1"如果必须修改 DSH 则延期"。

## 评估

| 项 | 结论 |
|---|---|
| T22-001 GenOffice 现接入 | 旧 METIS 通过 Electron 主进程挂载 genoffice sidecar（`stage-genoffice-sidecar.cjs` + `stage-genoffice-runtime.cjs`），运行时入口与旧壳生命周期绑定 |
| T22-002 许可证 | GenOffice 随仓库 vendor 分发，主体许可兼容；第三方子组件许可需在正式分发前逐项核对 |
| T22-003/004 docx/pptx 独立性 | docx-engine / pptx-engine 可作为纯库调用（`stage-genoffice-sidecar` 已验证可独立产出 xlsx-sidecar.exe），但完整编辑链依赖 genoffice runtime 的会话与文件桥 |
| T22-005 是否必须修改 DSH | **是**——Office 编辑器需要 DSH 侧提供应用内文档宿主能力（编辑器窗口挂载、文件会话桥），当前 DSH 无此公开扩展点 |
| T22-006 结论 | 依任务清单 22.1：**必须修改 DSH → 延期** |

## DEFER 期间可用的替代能力

- 文档解析（read_pdf / fulltext_search）已由插件测试覆盖；
- Artifact 插件可登记 .docx/.pptx/.xlsx 文件的领域身份与版本；
- 纯文本读写可走 DSH 原生 fs/bash 工具。

## Reopen 条件

DSH 提供应用内文档宿主公开扩展点，或 GenOffice runtime 拆出独立可嵌入库后重启评估。
