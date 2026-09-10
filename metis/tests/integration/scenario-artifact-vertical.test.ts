/**
 * 第二条垂直链路集成测试（Phase 19 / 任务清单 §19，Gate F 核心）。
 *
 * 链路：scenario 激活 literature-review → 真实文献检索 → Evidence + 保存进项目
 * → 生成 markdown 草稿（真实文件）→ artifact_register → 新版本 → 重启恢复
 * → 双方 id 关联正确。
 *
 * DSH 原生职责说明：Goal/Plan 由 DSH 原生 Goal/Plan 承担（本测试用直接驱动
 * 插件服务的方式验证同一条数据链路；模型自主发起环节待 DEEPSEEK_API_KEY）。
 *
 * @vitest-environment jsdom
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MetisScenario } from '../../plugins/scenario/src/index.ts';
import { MetisEvidence } from '../../plugins/evidence/src/index.ts';
import { MetisLiterature } from '../../plugins/literature/src/index.ts';
import { ArtifactStore } from '../../plugins/artifact/src/store.js';
import { OpenAlexProvider } from '../../plugins/literature-openalex/src/index.js';

const OPENALEX_QUERY = 'generative artificial intelligence knowledge workers';

describe('vertical slice 2: scenario → literature → draft → artifact (Gate F)', () => {
  it('activates the literature-review scenario, saves real literature, and registers a versioned draft artifact', async () => {
    const workdir = fs.mkdtempSync(path.join(process.cwd(), '.test-gatef-'));

    // ── 服务装配（真实插件实现；reflect 桩模拟 cordis 服务挂载） ──
    const fakeCtx = {
      reflect: { provide: () => {} },
      systemPrompt: { section: () => () => {} },
      tools: { register: () => () => {} },
    } as unknown as ConstructorParameters<typeof MetisScenario>[0];
    const scenario = new MetisScenario(fakeCtx);
    const evidence = new MetisEvidence(
      { reflect: { provide: () => {} } } as unknown as ConstructorParameters<typeof MetisEvidence>[0],
      path.join(workdir, 'metis-data', 'evidence.json'),
    );
    const literature = new MetisLiterature(
      {
        metisEvidence: evidence,
        reflect: { provide: () => {} },
      } as unknown as ConstructorParameters<typeof MetisLiterature>[0],
      {},
    );
    const artifacts = new ArtifactStore(path.join(workdir, 'metis-data', 'artifacts.json'));

    // ── 1. 场景激活（必需工具在注册表中） ──
    expect(scenario.getDefinition('literature-review')?.requiredTools.every((tool) =>
      ['literature_search', 'literature_save', 'ncpssd_search'].includes(tool))).toBe(true);
    const activation = scenario.activate('literature-review');
    expect(activation.ok).toBe(true);

    // ── 2. 真实文献检索（OpenAlex 真实 API） ──
    const openalex = new OpenAlexProvider();
    const found = await openalex.search({ query: OPENALEX_QUERY, limit: 3 });
    expect(found.length).toBeGreaterThan(0);
    for (const record of found) expect(record.source).toBe('openalex');

    // ── 3. Evidence + 保存进项目 ──
    const saved = literature.save(found, 'rp-gatef');
    expect(saved).toHaveLength(found.length);
    expect(saved.every((record) => record.evidenceId && record.projectId === 'rp-gatef')).toBe(true);

    // ── 4. 生成综述草稿（真实文件写入 workspace） ──
    const draftPath = path.join(workdir, 'literature-review-draft.md');
    const lines = [
      `# 文献综述：${OPENALEX_QUERY}`,
      '',
      '## 一、检索与来源',
      '',
      `本综述基于 OpenAlex 真实检索，命中 ${found.length} 篇；全部证据已登记（evidence id 见下）。`,
      '',
      '## 二、文献清单与证据链',
      '',
      ...saved.map((record, index) =>
        `${index + 1}. ${record.title}（${record.authors.map((author) => author.name).join(', ')}，${record.year ?? 'n.d.'}）— evidence: ${record.evidenceId}`),
      '',
      '## 三、研究缺口',
      '',
      '（待后续分析补全。）',
    ];
    fs.writeFileSync(draftPath, lines.join('\n'), 'utf8');
    expect(fs.readFileSync(draftPath, 'utf8')).toContain('evidence:');

    // ── 5. Artifact 登记与版本 ──
    const registered = artifacts.register({
      type: 'paper',
      title: '文献综述草稿 v1',
      path: draftPath,
      projectId: 'rp-gatef',
      source: 'scenario:literature-review',
      note: '场景 literature-review 第一轮产出',
    });
    const draftV2 = draftPath.replace('.md', '-v2.md');
    fs.writeFileSync(draftV2, `${fs.readFileSync(draftPath, 'utf8')}\n\n## 追加：第二轮补充\n`, 'utf8');
    const versioned = artifacts.addVersion(registered.id, draftV2, '第二轮补充');
    expect(versioned?.version).toBe(2);
    expect(versioned?.versions).toHaveLength(2);

    // ── 6. 重启恢复：新实例读取同一持久化文件，双方 id 关联正确 ──
    const reloadedArtifacts = new ArtifactStore(path.join(workdir, 'metis-data', 'artifacts.json'));
    const recovered = reloadedArtifacts.get(registered.id);
    expect(recovered).toBeDefined();
    expect(recovered?.projectId).toBe('rp-gatef');
    expect(recovered?.versions).toHaveLength(2);
    // Evidence 重启恢复。
    const reloadedEvidence = new MetisEvidence(
      { reflect: { provide: () => {} } } as unknown as ConstructorParameters<typeof MetisEvidence>[0],
      path.join(workdir, 'metis-data', 'evidence.json'),
    );
    expect(reloadedEvidence.storeService.queryByProject('rp-gatef').length).toBeGreaterThan(0);

    // 清理。
    fs.rmSync(workdir, { recursive: true, force: true });
  }, 60_000);
});
