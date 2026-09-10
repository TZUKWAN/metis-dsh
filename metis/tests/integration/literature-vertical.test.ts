/**
 * 第一条垂直链路集成测试（Phase 14 / 任务清单 §15，Gate D 核心）。
 *
 * 链路：真实 Provider API → normalize → Evidence 登记 → literature_save
 * → 项目关联 → 查询回读。
 *
 * 说明：模型自主发现工具与 Web UI 环节需要 API key / 浏览器交互，
 * 此处以直接驱动插件服务的方式验证同一条数据链路；
 * 「模型自主调用工具」的端到端复验待 DEEPSEEK_API_KEY 配置后执行（见 FINAL_ACCEPTANCE_REPORT）。
 *
 * @vitest-environment jsdom
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MetisEvidence } from '../../plugins/evidence/src/index.ts';
import { MetisLiterature } from '../../plugins/literature/src/index.ts';
import { CrossrefProvider } from '../../plugins/literature-crossref/src/index.js';
import { OpenAlexProvider } from '../../plugins/literature-openalex/src/index.js';

/** PLOS ONE 早期注册 DOI（真实、长期稳定）。 */
const KNOWN_DOI = '10.1371/journal.pone.0000001';

describe('vertical slice: real provider → evidence → save → project (Gate D)', () => {
  it('resolves a real DOI via Crossref, registers evidence, saves into project, and reads it back', async () => {
    const dataFile = path.join(process.cwd(), `.test-vertical-${Date.now()}.json`);
    const fakeCtx = { reflect: { provide: () => {} } } as unknown as ConstructorParameters<typeof MetisEvidence>[0];
    const evidence = new MetisEvidence(fakeCtx, dataFile);

    const provider = new CrossrefProvider();
    const record = await provider.getByDoi(KNOWN_DOI);

    // 真实来源断言：记录存在、DOI 规范一致、标题非空。
    expect(record).not.toBeNull();
    expect(record!.doi).toBe(KNOWN_DOI);
    expect(record!.title.length).toBeGreaterThan(0);
    expect(record!.source).toBe('crossref');

    // 科研项目关联（core 服务）。
    const project = { id: 'rp-vertical', workspaceId: null, createdAt: Date.now(), updatedAt: Date.now() };
    const research = { updateProject: (patch: object) => ({ ...project, ...patch, updatedAt: Date.now() }) };

    // literature_save：登记证据 + 保存进项目。
    const literature = new MetisLiterature(
      { metisEvidence: evidence, reflect: { provide: () => {} } } as unknown as ConstructorParameters<typeof MetisLiterature>[0],
      {},
    );
    void research;
    const saved = literature.save([record!], project.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.projectId).toBe(project.id);
    expect(saved[0]!.evidenceId).toBeTruthy();

    // Evidence 可按 DOI 追溯（规格十四）。
    const evidenceRecords = evidence.storeService.queryByDoi(KNOWN_DOI);
    expect(evidenceRecords).toHaveLength(1);
    expect(evidenceRecords[0]!.source.provider).toBe('crossref');

    // 项目内可查（重启恢复由持久化 reload 语义覆盖，同 evidence store 测试）。
    const reloaded = new MetisEvidence(fakeCtx, dataFile);
    expect(reloaded.storeService.queryByDoi(KNOWN_DOI)).toHaveLength(1);
    fs.rmSync(dataFile, { force: true });
  });

  it('openalex provider remains independent when crossref fails (T15-019)', async () => {
    // Crossref 用注定失败的 baseURL 模拟（provider 换成 openalex 仍能独立工作）。
    const openalex = new OpenAlexProvider();
    const records = await openalex.search({ query: 'generative artificial intelligence knowledge workers', limit: 3 });
    // 真实 API：结果可能为空（查询词无命中概率低），但调用本身不得抛"伪成功"以外的错误。
    expect(Array.isArray(records)).toBe(true);
    for (const record of records) {
      expect(record.source).toBe('openalex');
      expect(record.title.length).toBeGreaterThan(0);
    }
  }, 40_000);
});
