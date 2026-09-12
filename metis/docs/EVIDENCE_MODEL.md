# EVIDENCE_MODEL — 证据与 Claim 模型

三层结构：
1. **Source**（来源身份）：provider + sourceId/URL/DOI 归一去重；
2. **Evidence**（证据记录）：一次对来源的观察，含 verification_state（unverified → verified/conflicting/invalid/stale）；
3. **Claim**（科研判断）：claimType（factual/literature_finding/theoretical_proposition/statistical_result/web_fact/user_provided_fact）、可归属 Artifact、状态流转；通过 claim_evidence_links（supports/contradicts/context + confidence）关联证据；支持原文摘录与定位器（abstract/page/section/paragraph/table/figure/dataset_row/web_fragment/metadata）。

覆盖检查：`artifact_evidence_check { artifactId }` → totalClaims/supported/unverified/coverageRatio（第一版启发式，诚实标注）。

硬边界：正式引用必须对应已保存 LiteratureRecord 及其 Evidence；未核验内容必须显式标注「待核验」；系统不给无来源判断伪造证据。
