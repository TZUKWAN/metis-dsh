import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ScenarioMaterialService,
  inferMaterialCategory,
  MATERIAL_CATEGORIES,
} from '../../electron/ScenarioMaterialService.js';

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-materials-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function buildPptx(pages: string[][]): Promise<Buffer> {
  const zip = new JSZip();
  for (let index = 0; index < pages.length; index += 1) {
    const runs = pages[index]!.map((text) => `<a:t>${text}</a:t>`).join('');
    zip.file(`ppt/slides/slide${index + 1}.xml`, `<p:sld>${runs}</p:sld>`);
  }
  return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>;
}

describe('ScenarioMaterialService 项目材料库（2026-09-01）', () => {
  let service: ScenarioMaterialService;

  beforeEach(() => {
    service = new ScenarioMaterialService(tempRoot);
  });

  it('infers categories from file extensions', () => {
    expect(inferMaterialCategory('.py')).toBe('code');
    expect(inferMaterialCategory('.do')).toBe('code');
    expect(inferMaterialCategory('.dta')).toBe('data');
    expect(inferMaterialCategory('.sav')).toBe('data');
    expect(inferMaterialCategory('.pdf')).toBe('references');
    expect(inferMaterialCategory('.md')).toBe('notes');
    expect(inferMaterialCategory('.abc')).toBe('other');
  });

  it('extracts pptx slide text in page order', async () => {
    const bytes = await buildPptx([
      ['劳动过程理论', 'Braverman 的核心命题'],
      ['平台劳动', '算法管理的三种机制'],
    ]);
    const file = path.join(tempRoot, 'slides.pptx');
    fs.writeFileSync(file, bytes);
    const material = await service.importMaterial(file, { category: 'references', projectId: 'project-a' });
    const text = service.loadMaterialText(material.id) ?? '';
    expect(text).toContain('【第 1 页】');
    expect(text).toContain('劳动过程理论');
    expect(text).toContain('【第 2 页】');
    expect(text).toContain('算法管理');
  });

  it('archives binary statistical data files with guidance instead of failing', async () => {
    const file = path.join(tempRoot, 'survey.dta');
    fs.writeFileSync(file, Buffer.from('DTA-BINARY-CONTENT', 'utf8'));
    const material = await service.importMaterial(file, { projectId: 'project-a' });
    expect(material.charCount).toBe(0);
    const text = service.loadMaterialText(material.id) ?? '';
    expect(text).toContain('导出为 CSV');
  });

  it('lists materials filtered by project with categories, and deletes', async () => {
    const docA = path.join(tempRoot, 'interview-notes.md');
    fs.writeFileSync(docA, '# 访谈记录\n受访者一：数字劳动平台的接单体验……（略）');
    const docB = path.join(tempRoot, 'analysis.py');
    fs.writeFileSync(docB, 'import pandas as pd\n# 描述统计与回归分析脚本\nprint(pd.read_csv("survey.csv").describe())');

    await service.importMaterial(docA, { category: 'notes', projectId: 'project-a' });
    await service.importMaterial(docB, { category: 'code', projectId: 'project-b' });

    const projectA = service.listMaterials('project-a');
    expect(projectA).toHaveLength(1);
    expect(projectA[0]!.category).toBe('notes');

    const all = service.listMaterials();
    expect(all).toHaveLength(2);
    expect(MATERIAL_CATEGORIES).toContain('code');

    const target = projectA[0]!;
    expect(service.deleteMaterial(target.id)).toBe(true);
    expect(service.listMaterials('project-a')).toHaveLength(0);
  });

  it('supports category updates on stored materials', async () => {
    const doc = path.join(tempRoot, 'outline.md');
    fs.writeFileSync(doc, '## 论文大纲\n一、引言\n二、文献综述\n三、研究设计');
    const material = await service.importMaterial(doc, { category: 'notes', projectId: 'project-a' });
    expect(service.setMaterialCategory(material.id, 'template_spec')).toBe(true);
    expect(service.listMaterials('project-a')[0]!.category).toBe('template_spec');
  });
});
