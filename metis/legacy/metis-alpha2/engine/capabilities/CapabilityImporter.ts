/**
 * Capability 源注册表与展开导入器(2026-09-05 刘总要求,任务7 7B/十四节)。
 *
 * 10 个 GitHub 预置来源注册在案;导入器把每个来源**逐内部 Skill 展开**为
 * CapabilityManifest 条目(保留 sourceRepo/originalPath/version/license/digest/
 * tags),license 不允许/来源不明/内容不兼容时如实标注,不为数量强行复制。
 * 展开是纯函数(fetcher 由调用方注入:GitHub API/本地克隆/预包数据均可)。
 */

export interface CapabilitySourceSpec {
  id: string;
  repo: string;
  name: string;
  /** 逐内部 Skill 展开(仓库含多个独立 SKILL.md)或单条导入。 */
  expansion: 'per_skill' | 'single';
  domains: string[];
  researchStages: string[];
  /** license 待核验标记:导入器会如实写入 manifest,不假装已确认。 */
  licenseStatus: 'verified' | 'unverified';
  notes?: string;
}

export const CAPABILITY_SOURCES: readonly CapabilitySourceSpec[] = [
  { id: 'auto-empirical-research', repo: 'brycewang-stanford/Auto-Empirical-Research-Skills', name: 'Auto Empirical Research Skills', expansion: 'per_skill', domains: ['实证研究', '计算社会科学'], researchStages: ['analysis', 'writing'], licenseStatus: 'unverified' },
  { id: 'research-writing-skill', repo: 'Norman-bury/research-writing-skill', name: 'Research Writing Skill', expansion: 'single', domains: ['学术写作'], researchStages: ['writing'], licenseStatus: 'unverified' },
  { id: 'academicforge', repo: 'HughYau/AcademicForge', name: 'AcademicForge', expansion: 'per_skill', domains: ['学术写作', '研究方法'], researchStages: ['writing', 'review'], licenseStatus: 'unverified' },
  { id: 'paper-search-mcp', repo: 'openags/paper-search-mcp', name: 'Paper Search MCP', expansion: 'single', domains: ['文献检索'], researchStages: ['literature'], licenseStatus: 'unverified', notes: 'MCP 形态(外部 Tool Provider)' },
  { id: 'academic-humanizer', repo: 'AIScientists-Dev/academic-humanizer', name: 'Academic Humanizer', expansion: 'single', domains: ['学术表达'], researchStages: ['writing'], licenseStatus: 'unverified' },
  { id: 'cnki-skills', repo: 'cookjohn/cnki-skills', name: 'CNKI Skills', expansion: 'per_skill', domains: ['中文文献'], researchStages: ['literature'], licenseStatus: 'unverified', notes: '仅收编合法工作流;违反站点条款的自动化能力不导入' },
  { id: 'humanities-thesis-skill', repo: 'ganzhi-black/humanities-thesis-skill', name: 'Humanities Thesis Skill', expansion: 'single', domains: ['人文', '学位论文'], researchStages: ['writing'], licenseStatus: 'unverified' },
  { id: 'research-plugins', repo: 'wentorai/research-plugins', name: 'Research Plugins', expansion: 'per_skill', domains: ['研究方法'], researchStages: ['analysis', 'writing'], licenseStatus: 'unverified' },
  { id: 'social-science-paper-writing', repo: 'fakerqwq/social-science-paper-writing-skill', name: 'Social Science Paper Writing', expansion: 'single', domains: ['社会科学写作'], researchStages: ['writing'], licenseStatus: 'unverified' },
  { id: 'ai-research-skills', repo: 'WenyuChiou/ai-research-skills', name: 'AI Research Skills (目录仓库)', expansion: 'per_skill', domains: ['研究方法', 'AI辅助'], researchStages: ['analysis'], licenseStatus: 'unverified', notes: '市场目录仓库：本体技能已拆分到 research-hub/academic-writing-skills/zotero-skills 等 6 个子仓库单独注册' },
  // ── 2026-09-08 刘总清单扩容(入库不注入;绑定步骤才动态加载) ──
  { id: 'open-scholar-skill', repo: 'joshzyj/open-scholar-skill', name: 'Open Scholar Skill', expansion: 'single', domains: ['社会科学', '学术写作'], researchStages: ['literature', 'writing'], licenseStatus: 'unverified' },
  { id: 'academic-writing-jackuio', repo: 'jackuio440/academic-writing', name: 'Academic Writing', expansion: 'per_skill', domains: ['学术写作'], researchStages: ['writing'], licenseStatus: 'unverified' },
  { id: 'academic-writing-yuanzhao', repo: 'YuanZHAO321/Academic-Writing', name: 'Academic Writing (Structure & Review)', expansion: 'per_skill', domains: ['论文结构', '同行评审'], researchStages: ['writing', 'review'], licenseStatus: 'unverified' },
  { id: 'vishalsachdev-skills', repo: 'vishalsachdev/claude-skills', name: 'Vishal Sachdev Skills', expansion: 'per_skill', domains: ['论文写作'], researchStages: ['writing'], licenseStatus: 'unverified', notes: '仅导入研究相关子技能' },
  { id: 'academic-paper-skill', repo: 'xiaoshuntian/academic-paper-skill', name: 'Academic Paper Skill (中英文)', expansion: 'single', domains: ['中文学术论文', '引用规范'], researchStages: ['writing'], licenseStatus: 'unverified', notes: '含 GB/T 7714 引用需求' },
  { id: 'academic-writing-skills-wenyu', repo: 'WenyuChiou/academic-writing-skills', name: 'Evidence-Aligned Academic Writing', expansion: 'per_skill', domains: ['证据对齐写作'], researchStages: ['writing', 'review'], licenseStatus: 'unverified' },
  { id: 'academic-manuscript-skill', repo: 'kchemorion/academic-manuscript-skill', name: 'Academic Manuscript Skill', expansion: 'single', domains: ['Word手稿', '参考文献'], researchStages: ['writing'], licenseStatus: 'unverified', notes: 'Crossref/期刊格式' },
  { id: 'language-assessment-kit', repo: 'Shalice-in-AIland/claude-language-assessment-research-kit', name: 'Language Assessment Research Kit', expansion: 'per_skill', domains: ['文献综述矩阵'], researchStages: ['literature', 'review'], licenseStatus: 'unverified' },
  { id: 'clay-hhk-skills', repo: 'Clay-HHK/claude-skills', name: 'Clay HHK Skills', expansion: 'per_skill', domains: ['文献检索', '引用核验', '研究构思'], researchStages: ['literature', 'analysis', 'review'], licenseStatus: 'unverified', notes: '目录源;按标签索引研究子技能' },
  { id: 'humanities-skills', repo: 'kltng/humanities-skills', name: 'Humanities Skills (数字人文)', expansion: 'per_skill', domains: ['历史', '数字人文'], researchStages: ['literature', 'analysis'], licenseStatus: 'unverified', notes: 'Wikidata/TEI/档案' },
  { id: 'melodic-research-plugins', repo: 'melodic-software/claude-code-plugins', name: 'Melodic Deep Research', expansion: 'per_skill', domains: ['深度研究'], researchStages: ['literature'], licenseStatus: 'unverified', notes: '检索规划思想吸收进原生 Web Research' },
  { id: 'academic-paper-skills-lishix', repo: 'lishix520/academic-paper-skills', name: 'Academic Paper Skills (哲学)', expansion: 'per_skill', domains: ['哲学', '跨学科'], researchStages: ['writing', 'review'], licenseStatus: 'unverified' },
  { id: 'saidwivedi-research-skills', repo: 'saidwivedi/research-skills', name: 'Saidwivedi Research Skills', expansion: 'per_skill', domains: ['研究协作', '结果展示'], researchStages: ['analysis', 'writing'], licenseStatus: 'unverified' },
  { id: 'odinary-research-writing', repo: 'Odinary-AI/research-writing-skill', name: 'Research Positioning & Submission', expansion: 'single', domains: ['研究定位', '投稿'], researchStages: ['writing', 'submission'], licenseStatus: 'unverified' },
  { id: 'econometrics-skill', repo: 'xiaomihu1992/econometrics-skill', name: 'Econometrics Skill', expansion: 'per_skill', domains: ['计量经济学', '因果推断'], researchStages: ['analysis'], licenseStatus: 'unverified', notes: 'OLS/PSM/IV/DID/RDD' },
  { id: 'econ-paper-workflow', repo: 'CalebLiu/econ-paper-workflow', name: 'Econ Paper Workflow', expansion: 'single', domains: ['实证经济学'], researchStages: ['analysis', 'writing'], licenseStatus: 'unverified' },
  { id: 'ai4s-skills', repo: 'ai4s-research/ai4s-skills', name: 'AI4S Research Skills', expansion: 'per_skill', domains: ['AI4Science', '研究治理'], researchStages: ['analysis', 'writing'], licenseStatus: 'unverified' },
  { id: 'literature-survey-skill', repo: 'SNL-UCSB/literature-survey-skill', name: 'Literature Survey Skill', expansion: 'single', domains: ['系统文献综述'], researchStages: ['literature'], licenseStatus: 'unverified', notes: 'Intent→Triage→Deepen→Synthesize' },
  { id: 'agent-papers-cli', repo: 'collaborative-deep-research/agent-papers-cli', name: 'Agent Papers CLI', expansion: 'per_skill', domains: ['深度文献综述', '事实核验'], researchStages: ['literature', 'review'], licenseStatus: 'unverified' },
  { id: 'research-paper-aniket', repo: 'aniketkrs/research-paper', name: 'Research Paper (Multi-role)', expansion: 'single', domains: ['文献综述', '政策研究'], researchStages: ['literature', 'writing'], licenseStatus: 'unverified', notes: '只借鉴编排,不默认完全自治' },
  { id: 'ai-research-feedback', repo: 'claesbackman/AI-research-feedback', name: 'AI Research Feedback', expansion: 'per_skill', domains: ['科研评审'], researchStages: ['review'], licenseStatus: 'unverified', notes: '完整/轻量评审+可复现性审查' },
  { id: 'citation-verification', repo: 'Agents4Academia-AI/citation_verification', name: 'Citation Verification', expansion: 'single', domains: ['引用真实性'], researchStages: ['review'], licenseStatus: 'unverified', notes: '与 Claim-Evidence 链路绑定' },
  { id: 'cite-verify', repo: 'jonckr/cite-verify', name: 'Cite Verify', expansion: 'single', domains: ['参考文献核验'], researchStages: ['review', 'submission'], licenseStatus: 'unverified', notes: 'Crossref bibliography 验证' },
  { id: 'convergent-peer-review', repo: 'yudabitrends/convergent-peer-review', name: 'Convergent Peer Review', expansion: 'single', domains: ['同行评审'], researchStages: ['review'], licenseStatus: 'unverified', notes: '确定性停止规则' },
  { id: 'lcrawfurd-skills', repo: 'lcrawfurd/claude-skills', name: 'Lcrawfurd Review Skills', expansion: 'per_skill', domains: ['论文评审', '代码评审', '可复现性'], researchStages: ['review'], licenseStatus: 'unverified' },
  { id: 'alirezarezvani-skills', repo: 'alirezarezvani/claude-skills', name: 'Alireza Rezvani Skills', expansion: 'per_skill', domains: ['深度研究', '三角验证'], researchStages: ['literature', 'analysis'], licenseStatus: 'unverified' },
  { id: 'therealray0x-research', repo: 'TheRealRay0x/claude-research-skill', name: 'Deep Web Research Skill', expansion: 'single', domains: ['深度网络研究'], researchStages: ['literature'], licenseStatus: 'unverified' },
  { id: 'bednarjosef-research', repo: 'bednarjosef/claude-research-skill', name: 'OpenAlex OA Research', expansion: 'single', domains: ['开放获取'], researchStages: ['literature'], licenseStatus: 'unverified' },
  { id: 'borghei-skills', repo: 'borghei/Claude-Skills', name: 'Borghei Skills', expansion: 'per_skill', domains: ['研究综述', '基金写作'], researchStages: ['writing'], licenseStatus: 'unverified', notes: '挑选研究/基金类子技能' },
  { id: 'ai-analyst-plus', repo: 'ai-analyst-lab/ai-analyst-plus', name: 'AI Analyst Plus', expansion: 'per_skill', domains: ['因果分析', '分析设计'], researchStages: ['analysis'], licenseStatus: 'unverified' },
  { id: 'shichengf-claude-skill', repo: 'shichengf/ClaudeSkill', name: 'Shichengf Academic Skill', expansion: 'per_skill', domains: ['学术写作', '自检'], researchStages: ['writing', 'review'], licenseStatus: 'unverified' },
  { id: 'david-saeteros-skills', repo: 'David-Saeteros/claude-skills', name: 'David Saeteros Skills', expansion: 'per_skill', domains: ['论文写作', '基金写作'], researchStages: ['writing'], licenseStatus: 'unverified' },
  { id: 'claude-peer-review', repo: 'kenwilliford/claude-peer-review', name: 'Claude Peer Review', expansion: 'single', domains: ['多模型评审'], researchStages: ['review'], licenseStatus: 'unverified', notes: '需外部模型 CLI;默认不启用' },
  { id: 'baygent-skills', repo: 'Learning-Bayesian-Statistics/baygent-skills', name: 'Baygent Skills (贝叶斯)', expansion: 'per_skill', domains: ['贝叶斯建模', '因果推断'], researchStages: ['analysis'], licenseStatus: 'unverified' },
  { id: 'academic-paper-review', repo: 'ChanMeng666/academic-paper-review-skill', name: 'Academic Paper Review', expansion: 'single', domains: ['双视角审稿'], researchStages: ['review'], licenseStatus: 'unverified' },
  { id: 'ai-peer-review', repo: 'AlexWortega/ai-peer-review-skill', name: 'AI Peer Review (多 reviewer)', expansion: 'single', domains: ['多agent审稿'], researchStages: ['review'], licenseStatus: 'unverified' },
  { id: 'seabbs-skills', repo: 'seabbs/skills', name: 'Seabbs Academic Skills', expansion: 'per_skill', domains: ['学术写作', '文献检索'], researchStages: ['literature', 'writing'], licenseStatus: 'unverified', notes: '按技能级导入' },
  { id: 'ab-test-causal-skills', repo: 'WilliamWJHuang/ab-test-causal-inference-skills', name: 'AB-Test Causal Inference Skills', expansion: 'per_skill', domains: ['实验设计', '统计审查'], researchStages: ['analysis', 'review'], licenseStatus: 'unverified' },
  { id: 'ntcoding-skillz', repo: 'NTCoding/claude-skillz', name: 'NTCoding Data Visualization', expansion: 'per_skill', domains: ['数据可视化'], researchStages: ['analysis'], licenseStatus: 'unverified' },
  { id: 'drarunmitra-research-skills', repo: 'drarunmitra/research-skills', name: 'DraRunMitra Research Skills', expansion: 'per_skill', domains: ['定性研究', '时间序列', '可复现性'], researchStages: ['analysis', 'writing'], licenseStatus: 'unverified', notes: '目录源' },
  { id: 'karthik-dataviz-skill', repo: 'skthewimp/karthik-data-visualization-skill', name: 'Karthik Data Visualization', expansion: 'single', domains: ['数据故事', '可视化编排'], researchStages: ['analysis'], licenseStatus: 'unverified' },
  { id: 'neuromechanist-research-skills', repo: 'neuromechanist/research-skills', name: 'Neuromechanist Research Marketplace', expansion: 'per_skill', domains: ['项目', '基金', '图表'], researchStages: ['writing', 'analysis'], licenseStatus: 'unverified', notes: '目录桥' },
  { id: 'benchmark-research-skill', repo: 'EternalWavee/benchmark-research-skill', name: 'Benchmark Research Skill', expansion: 'single', domains: ['基准', '数据集'], researchStages: ['literature'], licenseStatus: 'unverified' },
  { id: 'presentation-ppt-maker', repo: 'elinglijiaoqiao/presentation-ppt-maker', name: 'Presentation PPT Maker', expansion: 'single', domains: ['学术汇报'], researchStages: ['writing'], licenseStatus: 'unverified', notes: '论文转幻灯片;图表提取与来源映射' },
  { id: 'paper-framework-figure-studio', repo: 'c-narcissus/paper-framework-figure-studio-pro', name: 'Paper Framework Figure Studio Pro', expansion: 'per_skill', domains: ['框架图', '机制图'], researchStages: ['writing'], licenseStatus: 'unverified', notes: '哲社科需改造成理论框架版本' },
  { id: 'speaker-notes-skill', repo: 'AI272/speaker', name: 'Speaker (讲稿生成)', expansion: 'single', domains: ['学术演讲', '答辩'], researchStages: ['writing'], licenseStatus: 'unverified', notes: '逐页讲稿写入 speaker notes' },
  { id: 'socialverse', repo: 'omicverse/socialverse', name: 'Socialverse (方法基础设施)', expansion: 'per_skill', domains: ['政策评估', '调查分析', '定性编码'], researchStages: ['analysis'], licenseStatus: 'unverified', notes: 'GPL 许可边界;导入时核验' },
  { id: 'citation-finder', repo: 'HuiyuLi-2000/citation-finder', name: 'Citation Finder', expansion: 'single', domains: ['论断支撑', '引用回填'], researchStages: ['writing', 'review'], licenseStatus: 'unverified', notes: '与 Claim-Evidence-Citation 闭环对应' },
  // ── WenyuChiou ai-research-skills 目录下的本体技能仓库（2026-09-05 全量导入时发现）──
  { id: 'wenyuchiou-research-hub', repo: 'WenyuChiou/research-hub', name: 'AI Research Skills · Research Hub', expansion: 'per_skill', domains: ['研究方法', '文献管理', 'AI辅助'], researchStages: ['literature', 'analysis'], licenseStatus: 'unverified', notes: 'ai-research-skills 目录的本体仓库之一（26 个 SKILL.md）' },
  { id: 'wenyuchiou-academic-writing', repo: 'WenyuChiou/academic-writing-skills', name: 'AI Research Skills · Academic Writing', expansion: 'per_skill', domains: ['学术写作'], researchStages: ['writing'], licenseStatus: 'unverified' },
  { id: 'wenyuchiou-zotero', repo: 'WenyuChiou/zotero-skills', name: 'AI Research Skills · Zotero', expansion: 'per_skill', domains: ['文献管理', 'Zotero'], researchStages: ['literature'], licenseStatus: 'unverified' },
  { id: 'wenyuchiou-codex-delegate', repo: 'WenyuChiou/codex-delegate', name: 'AI Research Skills · Codex Delegate', expansion: 'per_skill', domains: ['多智能体协作'], researchStages: ['analysis'], licenseStatus: 'unverified' },
  { id: 'wenyuchiou-antigravity-delegate', repo: 'WenyuChiou/antigravity-delegate', name: 'AI Research Skills · Antigravity Delegate', expansion: 'per_skill', domains: ['多智能体协作'], researchStages: ['analysis'], licenseStatus: 'unverified' },
  { id: 'wenyuchiou-agent-collab', repo: 'WenyuChiou/agent-collab-skills', name: 'AI Research Skills · Agent Collab', expansion: 'per_skill', domains: ['多智能体协作'], researchStages: ['analysis'], licenseStatus: 'unverified', notes: '目录仓库标注为 optional-harness 扩展' },
];

export interface ExpandedCapabilityManifest {
  id: string;
  kind: 'skill' | 'mcp';
  name: string;
  description: string;
  sourceRepo: string;
  sourceId: string;
  originalPath: string;
  version: string;
  license: string | null;
  licenseStatus: 'verified' | 'unverified';
  domains: string[];
  researchStages: string[];
  tags: string[];
  contentDigest: string;
  /** 导入判定:included=false 时如实记录排除原因,不为数量强行复制。 */
  included: boolean;
  exclusionReason?: string;
  systemPrompt: string;
}

function extractFrontmatterField(frontmatter: string, field: string): string | null {
  const match = new RegExp(`^${field}:\\s*(.+)$`, 'mu').exec(frontmatter);
  return match ? match[1]!.trim().slice(0, 300) : null;
}

/** 简单确定性 digest(导入排序/冻结用;安全审计另有正式摘要工具)。 */
export function contentDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0') + (text.length.toString(16));
}

export interface RepoSkillFile {
  path: string;
  content: string;
}

/**
 * 逐 Skill 展开:扫描一个来源仓库的全部 SKILL.md 文件,产出 CapabilityManifest
 * 候选条目。name 为空/正文过短(<80 字符,无实质内容)/含明显不兼容标记时
 * excluded=true 并如实写明原因。
 */
export function expandSourceSkills(source: CapabilitySourceSpec, files: RepoSkillFile[]): ExpandedCapabilityManifest[] {
  return files
    .filter((file) => file.path.toLowerCase().endsWith('skill.md'))
    .map((file) => parseMarkdownManifest(source, file));
}

/**
 * 扁平 Markdown 回退展开（2026-09-05 全量导入时发现部分清单仓库不含
 * SKILL.md，技能以扁平 .md 文档形态存在，如 lcrawfurd/claude-skills 的
 * paper-review.md、xiaoshuntian 的 prompts/*.md）。解析规则与 SKILL.md
 * 一致（frontmatter/首标题/正文长度门槛），仅排除原因文案不同。
 */
export function expandFlatMarkdownSkills(source: CapabilitySourceSpec, files: RepoSkillFile[]): ExpandedCapabilityManifest[] {
  return files.map((file) => {
    const manifest = parseMarkdownManifest(source, file);
    if (!manifest.included && manifest.exclusionReason?.includes('SKILL.md')) {
      return { ...manifest, exclusionReason: 'Markdown 文件无实质内容(正文不足 80 字符)' };
    }
    return manifest;
  });
}

function parseMarkdownManifest(source: CapabilitySourceSpec, file: RepoSkillFile): ExpandedCapabilityManifest {
  const lower = file.path.toLowerCase();
  const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(file.content);
  const frontmatter = frontmatterMatch?.[1] ?? '';
  const name = extractFrontmatterField(frontmatter, 'name')
    ?? /^#\s+(.+)$/mu.exec(file.content)?.[1]?.trim()
    ?? file.path.split('/').slice(-2, -1)[0]
    ?? lower.replace(/\.md$/u, '');
  const description = extractFrontmatterField(frontmatter, 'description')
    ?? file.content.split('\n').find((line) => line.trim().length > 30 && !line.startsWith('#'))?.trim().slice(0, 300)
    ?? '';
  const license = extractFrontmatterField(frontmatter, 'license');
  const bodyStart = frontmatterMatch ? file.content.indexOf('---', 4) + 3 : 0;
  const body = file.content.slice(bodyStart).trim();
  if (body.length < 80) {
    return {
      id: `${source.id}:${file.path}`,
      kind: 'skill', name, description, sourceRepo: source.repo, sourceId: source.id,
      originalPath: file.path, version: '1', license, licenseStatus: source.licenseStatus,
      domains: source.domains, researchStages: source.researchStages,
      tags: [...source.domains, ...source.researchStages], contentDigest: contentDigest(file.content),
      included: false, exclusionReason: 'SKILL.md 无实质内容(正文不足 80 字符)', systemPrompt: '',
    };
  }
  return {
    id: `${source.id}:${file.path}`,
    kind: 'skill', name, description, sourceRepo: source.repo, sourceId: source.id,
    originalPath: file.path, version: '1',
    license: license ?? source.licenseStatus === 'verified' ? license : (license ?? 'UNVERIFIED'),
    licenseStatus: source.licenseStatus,
    domains: source.domains, researchStages: source.researchStages,
    tags: [...source.domains, ...source.researchStages], contentDigest: contentDigest(file.content),
    included: true, systemPrompt: file.content.trim(),
  };
}

// ── GitHub 真实拉取管线(任务7 7B:端到端展开导入)──

export interface GitHubFetcher {
  /** GET a raw text file at ref (default branch). */
  (url: string): Promise<string>;
}

const GITHUB_API = 'https://api.github.com';

/**
 * 扁平 Markdown 回退的噪音排除：模板/CI/实验记录/示例交付物/测试夹具
 * 不是技能，不进目录。README 保留（技能形态仓库的使用说明有真实价值）。
 */
const FLAT_MD_NOISE: ReadonlyArray<RegExp> = [
  /^\.github\//i,
  /^\.research\//i,
  /(^|\/)contributing\.md$/i,
  /(^|\/)changelog\.md$/i,
  /(^|\/)license(\.txt|\.md)?$/i,
  /(^|\/)pull_request_template\.md$/i,
  /(^|\/)issue_template/i,
  /^tests?\//i,
  /^examples?\//i,
];

/**
 * 拉取一个来源仓库的全部 SKILL.md 并逐 Skill 展开；仓库不含 SKILL.md 时
 * 回退为扁平 Markdown 展开（噪音过滤后逐文件一条）。
 * fetcher 注入:传 undici 封装(GitHub API 需要可选 token)或测试 stub。
 * 任一网络失败即抛出,由调用方如实报告(不伪造 0 结果)。
 */
export async function fetchAndExpandSource(
  source: CapabilitySourceSpec,
  fetcher: GitHubFetcher,
  token?: string,
): Promise<ExpandedCapabilityManifest[]> {
  void token; // token 由注入的 fetcher 自行携带(GitHub API 限流时可传)。
  const branchRes = await fetcher(`${GITHUB_API}/repos/${source.repo}`);
  const branch = JSON.parse(branchRes) as { default_branch?: string };
  const ref = branch.default_branch || 'main';
  const treeRes = await fetcher(`${GITHUB_API}/repos/${source.repo}/git/trees/${ref}?recursive=1`);
  const tree = JSON.parse(treeRes) as { tree?: Array<{ path: string; type: string }> };
  const blobs = (tree.tree ?? []).filter((entry) => entry.type === 'blob');
  const skillPaths = blobs
    .filter((entry) => entry.path.toLowerCase().endsWith('skill.md'))
    .map((entry) => entry.path)
    .slice(0, 60);
  if (skillPaths.length > 0) {
    const files: RepoSkillFile[] = [];
    for (const path of skillPaths) {
      const raw = await fetcher(`https://raw.githubusercontent.com/${source.repo}/${ref}/${path}`);
      files.push({ path, content: raw });
    }
    return expandSourceSkills(source, files);
  }
  // 扁平 Markdown 回退：仓库没有 SKILL.md 形态的技能。
  const markdownPaths = blobs
    .filter((entry) => entry.path.toLowerCase().endsWith('.md')
      && !FLAT_MD_NOISE.some((pattern) => pattern.test(entry.path)))
    .map((entry) => entry.path)
    .slice(0, 60);
  const files: RepoSkillFile[] = [];
  for (const path of markdownPaths) {
    const raw = await fetcher(`https://raw.githubusercontent.com/${source.repo}/${ref}/${path}`);
    files.push({ path, content: raw });
  }
  return expandFlatMarkdownSkills(source, files);
}
