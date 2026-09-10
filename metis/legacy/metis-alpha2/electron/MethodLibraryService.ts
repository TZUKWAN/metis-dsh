/**
 * MethodLibraryService — 方法库（T4）。
 *
 * 把"跑通过的做法"沉淀为可复用资产：方法 = 名称 + 参数占位（{{参数}}）
 * + 步骤模板（发给项目对话的指令序列）。重放时填参数一键应用到当前项目
 * 对话，由既有 agent loop（带全部研究工具）执行 —— 不重复造执行引擎。
 *
 * 存储：dataDir/methods.json（原子读写，保留最近 200 次运行记录）。
 * Token 经济：模板即已调试好的精简指令；确定性部分（检索/统计）由
 * 工具执行，不经模型笔算（T6 铁律）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';

export interface MethodStep {
  /** 指令模板，支持 {{参数名}} 占位。 */
  template: string;
}

export interface MethodDefinition {
  id: string;
  name: string;
  description: string;
  /** 参数占位符定义：名称 → 示例值（渲染层生成填写表单）。 */
  params: Record<string, string>;
  steps: MethodStep[];
  /** 每步之间是否停下等用户确认（T11 审批）。 */
  confirmEachStep: boolean;
  sourceProjectId: string | null;
  createdAt: number;
  updatedAt: number;
  runCount: number;
  lastRunAt: number | null;
}

export interface MethodRunRecord {
  id: string;
  methodId: string;
  projectId: string | null;
  params: Record<string, string>;
  at: number;
  outcome: 'applied' | 'cancelled';
}

interface MethodStore {
  version: 1;
  methods: MethodDefinition[];
  runs: MethodRunRecord[];
  /** 用户显式删除过的内置方法 id（防止重启后被 seed 复活）。 */
  deletedBuiltins?: string[];
}

const MAX_RUNS = 200;
const PARAM_PATTERN = /\{\{\s*([a-zA-Z0-9_\u4e00-\u9fff]+)\s*\}\}/gu;

export class MethodLibraryService {
  private readonly filePath: string;
  private store: MethodStore;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'methods.json');
    this.store = this.load();
    this.seedBuiltinMethods();
  }

  /** 内置科研方法（T12/T13）：首次运行预置，幂等（按 builtin 标记去重）。 */
  private seedBuiltinMethods(): void {
    const builtins: Array<{ builtinId: string; name: string; description: string; steps: string[]; confirmEachStep: boolean }> = [
      {
        builtinId: 'builtin-review-matrix',
        name: '文献综述矩阵',
        description: '对项目文献生成「作者/年份/理论/方法/发现/局限」六列综述矩阵，并归纳研究缺口。适合文献阶段。',
        confirmEachStep: false,
        steps: [
          '先用 list_sources 查看当前项目「{{主题}}」相关的全部文献清单；如果不足 8 篇，提醒我先去资料模式检索导入。',
          '对每篇文献使用 search_paper_text 检索其核心论点与发现（不要凭记忆编造），然后输出六列综述矩阵：作者/年份/理论视角/研究方法/核心发现/局限。',
          '基于矩阵归纳 3-5 个研究缺口，每个缺口注明支撑它的是矩阵中的哪些文献，最后用 verify_numbers 核查矩阵中出现的所有数字。',
        ],
      },
      {
        builtinId: 'builtin-gap-analysis',
        name: '研究缺口分析',
        description: '从研究问题出发，结合项目文献与证据，识别现有研究的空白并提议候选研究问题。适合选题阶段。',
        confirmEachStep: false,
        steps: [
          '复述我的研究问题「{{研究问题}}」，用 search_paper_text 在项目文献全文中检索与该问题最相关的段落。',
          '按理论、方法、数据三个维度总结现有研究分别做到了什么、没做到什么（每条注明出处文献）。',
          '提出 3 个候选研究问题，每个附：理论贡献、所需数据与可得性评估、推荐方法（用 check_method_fit 校验）。',
        ],
      },
      {
        builtinId: 'builtin-grounded-coding',
        name: '扎根编码辅助',
        description: '对访谈/资料文本做开放式编码建议：逐段建议码、落码簿待确认、汇总主轴方向。适合定性分析阶段。',
        confirmEachStep: true,
        steps: [
          '先 list_note_codes 查看既有码簿，保持命名一致。',
          '对资料「{{材料名称}}」逐段建议开放编码：每个码给出名称、定义、原文摘录（必须逐字），并用 save_note_code 保存为待确认建议。',
          '汇总本轮新码与既有码的关系，提出 2-3 个主轴编码方向供我决策（不要自行合并）。',
        ],
      },
      {
        builtinId: 'builtin-paper-skeleton',
        name: '论文骨架写作',
        description: '按骨架树逐节起草论文：每节绑定大纲要点与文献引用，全文术语一致，引注用 format_citations 成对生成。适合写作阶段。',
        confirmEachStep: true,
        steps: [
          '基于研究问题「{{研究问题}}」与项目证据（list_sources），给出论文骨架树：每节标题 + 该节大纲要点（3-5 条）+ 计划引用的文献 id 清单，先给我确认骨架。',
          '对骨架中的「引言」与「文献综述」两节逐节起草：每节按大纲要点展开，引用处用 format_citations 生成文中引注，禁止出现没有文献支撑的文献性论断。',
          '起草「研究设计」「发现与分析」两节：所有数字必须来自我提供的计算事实或工具输出，写完用 verify_numbers 自查本节全部数字。',
          '起草「结论与讨论」与摘要：结论不得超出证据边界，讨论回应至少一个替代解释；最后输出全文术语表检查（同一概念全文用词一致）。',
        ],
      },
      {
        builtinId: 'builtin-research-design',
        name: '研究设计五步法',
        description: '研究问题→假设→变量操作化→方法选择→数据来源，五步表单化设计；方法自动过适切性门。适合设计阶段。',
        confirmEachStep: true,
        steps: [
          '围绕研究问题「{{研究问题}}」，先复述问题并指出 2-3 种可能的理论视角（基于项目文献，注明出处），供我选择。',
          '基于选定视角提出可检验的研究假设（每条：自变量、因变量、方向、理论依据）。',
          '对每个假设做概念操作化：给出变量定义、测量方式、数据类型；说明数据来源与可得性。',
          '用 check_method_fit 校验候选统计方法（提供样本量、因变量类型、内生性判断），给出方法建议与理由。',
          '汇总为一页研究设计方案：问题、假设、变量表、方法、数据计划、时间安排，交我确认。',
        ],
      },
      {
        builtinId: 'builtin-describe-regress',
        name: '描述统计与回归',
        description: '把数据交给本地统计引擎：描述统计、交叉表、回归全部由确定性代码计算，结果带溯源，杜绝模型笔算。适合分析阶段。',
        confirmEachStep: false,
        steps: [
          '我会提供 CSV 数据。先用 run_statistics 的 describe 命令对所有数值列做描述统计（每次一列），用 crosstab 检查关键分类变量的分布与关联。',
          '根据研究假设用 check_method_fit 确定回归方法后，用 run_statistics 的 ols 命令估计模型；引用返回的 facts（不要手写任何数字）。',
          '用 verify_numbers 对你撰写的分析文字做数字一致性自查，然后输出结果表（系数/标准误/t/p/R²）与一段基于事实的解读。',
        ],
      },
    ];
    let changed = false;
    const deleted = new Set(this.store.deletedBuiltins ?? []);
    for (const builtin of builtins) {
      if (deleted.has(builtin.builtinId)) continue;
      if (this.store.methods.some((method) => method.id === builtin.builtinId)) continue;
      this.store.methods.push({
        id: builtin.builtinId,
        name: builtin.name,
        description: builtin.description,
        params: this.extractParams(builtin.steps.map((template) => ({ template }))),
        steps: builtin.steps.map((template) => ({ template })),
        confirmEachStep: builtin.confirmEachStep,
        sourceProjectId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        runCount: 0,
        lastRunAt: null,
      });
      changed = true;
    }
    if (changed) this.persist();
  }

  private load(): MethodStore {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as MethodStore;
      if (parsed && Array.isArray(parsed.methods)) {
        return {
          version: 1,
          methods: parsed.methods,
          runs: Array.isArray(parsed.runs) ? parsed.runs : [],
          deletedBuiltins: Array.isArray(parsed.deletedBuiltins) ? parsed.deletedBuiltins : [],
        };
      }
    } catch { /* 首次运行无文件 */ }
    return { version: 1, methods: [], runs: [] };
  }

  private persist(): void {
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.store, null, 1), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch { /* 持久化尽力而为 */ }
  }

  listMethods(): MethodDefinition[] {
    return [...this.store.methods].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getMethod(methodId: string): MethodDefinition | null {
    return this.store.methods.find((method) => method.id === methodId) ?? null;
  }

  /** 从步骤模板中提取参数占位（按出现顺序）。 */
  extractParams(steps: Array<{ template: string }>): Record<string, string> {
    const params: Record<string, string> = {};
    for (const step of steps) {
      for (const match of step.template.matchAll(PARAM_PATTERN)) {
        const name = match[1]!;
        if (!(name in params)) params[name] = '';
      }
    }
    return params;
  }

  createMethod(input: {
    name: string;
    description?: string;
    steps: Array<{ template: string }>;
    confirmEachStep?: boolean;
    sourceProjectId?: string | null;
  }): MethodDefinition | null {
    const name = input.name.trim().slice(0, 80);
    if (!name || input.steps.length === 0) return null;
    const now = Date.now();
    const method: MethodDefinition = {
      id: `method-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      description: (input.description ?? '').trim().slice(0, 400),
      params: this.extractParams(input.steps),
      steps: input.steps.map((step) => ({ template: step.template.slice(0, 4000) })),
      confirmEachStep: input.confirmEachStep ?? false,
      sourceProjectId: input.sourceProjectId ?? null,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      lastRunAt: null,
    };
    this.store.methods.push(method);
    this.persist();
    return method;
  }

  updateMethod(methodId: string, patch: {
    name?: string;
    description?: string;
    steps?: Array<{ template: string }>;
    confirmEachStep?: boolean;
  }): MethodDefinition | null {
    const method = this.getMethod(methodId);
    if (!method) return null;
    if (patch.name !== undefined) method.name = patch.name.trim().slice(0, 80) || method.name;
    if (patch.description !== undefined) method.description = patch.description.trim().slice(0, 400);
    if (patch.steps !== undefined && patch.steps.length > 0) {
      method.steps = patch.steps.map((step) => ({ template: step.template.slice(0, 4000) }));
      method.params = this.extractParams(method.steps);
    }
    if (patch.confirmEachStep !== undefined) method.confirmEachStep = patch.confirmEachStep;
    method.updatedAt = Date.now();
    this.persist();
    return method;
  }

  deleteMethod(methodId: string): boolean {
    const before = this.store.methods.length;
    this.store.methods = this.store.methods.filter((method) => method.id !== methodId);
    this.store.runs = this.store.runs.filter((run) => run.methodId !== methodId);
    const removed = this.store.methods.length < before;
    if (removed) {
      if (methodId.startsWith('builtin-')) {
        this.store.deletedBuiltins = [...new Set([...(this.store.deletedBuiltins ?? []), methodId])];
      }
      this.persist();
    }
    return removed;
  }

  /** 填充参数 → 每步一条指令（重放载荷）。 */
  renderSteps(methodId: string, params: Record<string, string>): Array<{ instruction: string }> | null {
    const method = this.getMethod(methodId);
    if (!method) return null;
    return method.steps.map((step) => ({
      instruction: step.template.replace(PARAM_PATTERN, (_match, name: string) => (params[name] ?? '').trim() || `（请补充：${name}）`),
    }));
  }

  recordRun(methodId: string, projectId: string | null, params: Record<string, string>, outcome: 'applied' | 'cancelled'): void {
    const method = this.getMethod(methodId);
    if (!method) return;
    method.runCount += 1;
    method.lastRunAt = Date.now();
    this.store.runs.push({
      id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      methodId,
      projectId,
      params,
      at: Date.now(),
      outcome,
    });
    if (this.store.runs.length > MAX_RUNS) {
      this.store.runs = this.store.runs.slice(-MAX_RUNS);
    }
    this.persist();
  }

  listRuns(methodId?: string): MethodRunRecord[] {
    return this.store.runs
      .filter((run) => !methodId || run.methodId === methodId)
      .sort((a, b) => b.at - a.at)
      .slice(0, 50);
  }

  registerIpc(): void {
    ipcMain.handle('methods:list', () => this.listMethods());
    ipcMain.handle('methods:getRuns', (_event, rawMethodId: unknown) =>
      typeof rawMethodId === 'string' ? this.listRuns(rawMethodId) : this.listRuns());
    ipcMain.handle('methods:create', (_event, raw: unknown) => {
      const input = raw as { name?: unknown; description?: unknown; steps?: unknown; confirmEachStep?: unknown; sourceProjectId?: unknown };
      const steps = Array.isArray(input?.steps)
        ? (input.steps as Array<{ template?: unknown }>)
            .filter((step) => typeof step?.template === 'string' && step.template.trim())
            .map((step) => ({ template: step.template as string }))
        : [];
      if (typeof input?.name !== 'string' || !input.name.trim() || steps.length === 0) return null;
      return this.createMethod({
        name: input.name,
        description: typeof input.description === 'string' ? input.description : '',
        steps,
        confirmEachStep: input.confirmEachStep === true,
        sourceProjectId: typeof input.sourceProjectId === 'string' ? input.sourceProjectId : null,
      });
    });
    ipcMain.handle('methods:update', (_event, raw: unknown) => {
      const input = raw as { id?: unknown; name?: unknown; description?: unknown; steps?: unknown; confirmEachStep?: unknown };
      if (typeof input?.id !== 'string') return null;
      const steps = Array.isArray(input?.steps)
        ? (input.steps as Array<{ template?: unknown }>)
            .filter((step) => typeof step?.template === 'string' && step.template.trim())
            .map((step) => ({ template: step.template as string }))
        : undefined;
      return this.updateMethod(input.id, {
        name: typeof input.name === 'string' ? input.name : undefined,
        description: typeof input.description === 'string' ? input.description : undefined,
        steps,
        confirmEachStep: typeof input.confirmEachStep === 'boolean' ? input.confirmEachStep : undefined,
      });
    });
    ipcMain.handle('methods:delete', (_event, rawId: unknown) => {
      if (typeof rawId !== 'string') return false;
      return this.deleteMethod(rawId);
    });
    ipcMain.handle('methods:render', (_event, raw: unknown) => {
      const input = raw as { id?: unknown; params?: unknown };
      if (typeof input?.id !== 'string') return null;
      const params = (input.params && typeof input.params === 'object' ? input.params : {}) as Record<string, string>;
      return this.renderSteps(input.id, params);
    });
    ipcMain.handle('methods:recordRun', (_event, raw: unknown) => {
      const input = raw as { id?: unknown; projectId?: unknown; params?: unknown; outcome?: unknown };
      if (typeof input?.id !== 'string') return;
      this.recordRun(
        input.id,
        typeof input.projectId === 'string' ? input.projectId : null,
        (input.params && typeof input.params === 'object' ? input.params : {}) as Record<string, string>,
        input.outcome === 'cancelled' ? 'cancelled' : 'applied',
      );
    });
  }
}
