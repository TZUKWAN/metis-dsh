# RESEARCH_EVALS — 科研质量评测

`metis/evals/tasks.json` 定义 8 个真实哲社科任务（社会学综述/马克思主义理论/政治学研究设计/
教育学/论文审读/选刊/基金模板/历史概念）。`evals/run-evals.ts` 通过正常产品能力执行
（boot 真实运行时 + 真实模型自主调用），不预置产物、不替 Agent 做科研。

结构化指标：taskCompleted / artifactCreated / citationsTotal / citationsVerified /
evidenceCoverage / unsupportedClaims / toolErrors / providerFailures（无 LLM Judge；结构化事实优先）。
结果写入 `metis/evals/results-latest.json`。凭据缺失 → BLOCKED_EXTERNAL，不伪造。
