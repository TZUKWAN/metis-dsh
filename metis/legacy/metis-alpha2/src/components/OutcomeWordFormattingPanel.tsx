import { useEffect, useMemo, useState } from 'react';
import { LayoutPanelTop, SlidersHorizontal, X } from 'lucide-react';
import {
  WordFormattingTemplateDefinitionSchema,
  outcomeTemplateRecordSchema,
  type WordDocument,
  type WordFormattingTemplateDefinition,
} from '../../engine/runtime/OutcomeRuntimeContract';
import {
  applyWordFormatting,
  parseWordFormattingInstruction,
  type WordFormattingConfig,
} from '../../engine/outcomes/WordDocumentFormatting';
import './OutcomeWordFormattingPanel.css';
import { useTranslation } from '../i18n';

type Props = Readonly<{
  document: WordDocument;
  onApply: (document: WordDocument, note: string) => void;
  openRequest?: number;
  hideTrigger?: boolean;
}>;

type WordTemplate = ReturnType<typeof outcomeTemplateRecordSchema.parse>;
const defaultDefinition = (config: WordFormattingConfig, header: string, footer: string, pageNumber: boolean): WordFormattingTemplateDefinition => ({ config: config as unknown as WordFormattingTemplateDefinition['config'], header, footer, pageNumber });

type BodyConfig = NonNullable<WordFormattingConfig['body']>;
type PageConfig = NonNullable<WordFormattingConfig['page']>;
type HeadingStyleConfig = {
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  lineSpacing?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
};
type HeadingsConfig = Partial<Record<1 | 2 | 3 | 4 | 5 | 6, HeadingStyleConfig>>;
type CaptionsConfig = NonNullable<WordFormattingConfig['captions']>;

function defaultHeadingsForBody(body: BodyConfig): HeadingsConfig {
  return {
    1: { fontFamily: '黑体', fontSizePt: 16, align: 'center', spaceBeforePt: 12, spaceAfterPt: 6 },
    2: { fontFamily: '黑体', fontSizePt: 14, spaceBeforePt: 10, spaceAfterPt: 5 },
    3: { fontFamily: body.fontFamily, fontSizePt: body.fontSizePt, spaceBeforePt: 8, spaceAfterPt: 4 },
    4: {}, 5: {}, 6: {},
  };
}

function defaultCaptionsForBody(body: BodyConfig): CaptionsConfig {
  return { fontFamily: body.fontFamily, fontSizePt: Math.max(8, (body.fontSizePt ?? 12) - 1), align: 'center' };
}

const initialBody: BodyConfig = Object.freeze({
  fontFamily: '宋体', fontSizePt: 12, align: 'justify', firstLineIndentChars: 2,
  lineSpacing: 1.5, spaceBeforePt: 0, spaceAfterPt: 6,
});
function numberValue(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function centimetersFromPage(page: Record<string, unknown>, cmKey: keyof PageConfig, pointKey: string, fallback: number): number {
  const centimeters = finiteNumber(page[cmKey]);
  if (centimeters !== undefined) return centimeters;
  const points = finiteNumber(page[pointKey]);
  return points === undefined ? fallback : Math.round((points / 72 * 2.54) * 100) / 100;
}

function pageConfigFromDocument(document: WordDocument): PageConfig {
  const source = document.page as Record<string, unknown>;
  const paper: PageConfig['paper'] = source.paper === 'Letter' || source.paper === 'custom' ? source.paper : 'A4';
  return {
    paper,
    marginTopCm: centimetersFromPage(source, 'marginTopCm', 'marginTop', paper === 'A4' ? 2.54 : 2.54),
    marginBottomCm: centimetersFromPage(source, 'marginBottomCm', 'marginBottom', paper === 'A4' ? 2.54 : 2.54),
    marginLeftCm: centimetersFromPage(source, 'marginLeftCm', 'marginLeft', paper === 'A4' ? 3.17 : 2.54),
    marginRightCm: centimetersFromPage(source, 'marginRightCm', 'marginRight', paper === 'A4' ? 3.17 : 2.54),
  };
}

function bodyConfigFromDocument(document: WordDocument): BodyConfig {
  // Body controls describe real paragraphs only; heading/caption styles have
  // their own state and must not leak into the body fields.
  const source = (document.blocks.find((block) => block.kind === 'paragraph')?.style ?? {}) as Record<string, unknown>;
  return {
    fontFamily: typeof source.fontFamily === 'string' ? source.fontFamily : initialBody.fontFamily,
    fontSizePt: finiteNumber(source.fontSizePt) ?? finiteNumber(source.fontSize) ?? initialBody.fontSizePt,
    align: source.align === 'left' || source.align === 'center' || source.align === 'right' || source.align === 'justify' ? source.align : initialBody.align,
    firstLineIndentChars: finiteNumber(source.firstLineIndentChars) ?? (finiteNumber(source.firstLineIndent) !== undefined && (finiteNumber(source.fontSizePt) ?? finiteNumber(source.fontSize) ?? 12) > 0 ? Math.round((finiteNumber(source.firstLineIndent) as number / (finiteNumber(source.fontSizePt) ?? finiteNumber(source.fontSize) ?? 12)) * 100) / 100 : initialBody.firstLineIndentChars),
    lineSpacing: finiteNumber(source.lineSpacing) ?? initialBody.lineSpacing,
    spaceBeforePt: finiteNumber(source.spaceBeforePt) ?? finiteNumber(source.spaceBefore) ?? initialBody.spaceBeforePt,
    spaceAfterPt: finiteNumber(source.spaceAfterPt) ?? finiteNumber(source.spaceAfter) ?? initialBody.spaceAfterPt,
  };
}

function paragraphConfigFromStyle(style: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (typeof style.fontFamily === 'string' && style.fontFamily.trim()) config.fontFamily = style.fontFamily;
  const fontSizePt = finiteNumber(style.fontSizePt) ?? finiteNumber(style.fontSize);
  if (fontSizePt !== undefined) config.fontSizePt = fontSizePt;
  if (typeof style.color === 'string') config.color = style.color;
  if (style.align === 'left' || style.align === 'center' || style.align === 'right' || style.align === 'justify') config.align = style.align;
  const lineSpacing = finiteNumber(style.lineSpacing);
  if (lineSpacing !== undefined) config.lineSpacing = lineSpacing;
  const spaceBeforePt = finiteNumber(style.spaceBeforePt) ?? finiteNumber(style.spaceBefore);
  if (spaceBeforePt !== undefined) config.spaceBeforePt = spaceBeforePt;
  const spaceAfterPt = finiteNumber(style.spaceAfterPt) ?? finiteNumber(style.spaceAfter);
  if (spaceAfterPt !== undefined) config.spaceAfterPt = spaceAfterPt;
  return config;
}

function formattingConfigFromDocument(document: WordDocument, body: BodyConfig): { headings: HeadingsConfig; captions: CaptionsConfig } {
  const headings = defaultHeadingsForBody(body);
  const captions = defaultCaptionsForBody(body);
  document.blocks.forEach((block) => {
    const style = (block.style ?? {}) as Record<string, unknown>;
    if (block.kind === 'heading') {
      const level = Math.min(6, Math.max(1, block.level ?? 1)) as keyof HeadingsConfig;
      headings[level] = { ...headings[level], ...paragraphConfigFromStyle(style) } as HeadingsConfig[typeof level];
    } else if (block.kind === 'figure_caption' || block.kind === 'table_caption') {
      Object.assign(captions, paragraphConfigFromStyle(style));
    }
  });
  return { headings, captions };
}

/** A local layout panel: it writes the document model, never just preview CSS. */
export function OutcomeWordFormattingPanel({ document, onApply, openRequest = 0, hideTrigger = false }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [body, setBody] = useState<BodyConfig>(() => bodyConfigFromDocument(document));
  const [page, setPage] = useState<PageConfig>(() => pageConfigFromDocument(document));
  const [headings, setHeadings] = useState<HeadingsConfig>(() => defaultHeadingsForBody(bodyConfigFromDocument(document)));
  const [captions, setCaptions] = useState<CaptionsConfig>(() => defaultCaptionsForBody(bodyConfigFromDocument(document)));
  const [header, setHeader] = useState(document.header);
  const [footer, setFooter] = useState(document.footer);
  const [pageNumber, setPageNumber] = useState(document.page.pageNumber === true);
  const [notice, setNotice] = useState('');
  const [templates, setTemplates] = useState<WordTemplate[]>([]);
  const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [importedTemplate, setImportedTemplate] = useState<{ fileName: string; config: WordFormattingConfig; recognized: string[]; unrecognized: string[] } | null>(null);
  const [importedTemplateName, setImportedTemplateName] = useState('');
  const [importing, setImporting] = useState(false);
  const [guidelineText, setGuidelineText] = useState('');
  const [parsingGuideline, setParsingGuideline] = useState(false);

  const currentConfig = (): WordFormattingConfig => ({ page, body, headings, captions });

  useEffect(() => {
    let active = true;
    const bridge = window.metis;
    if (!bridge?.listOutcomeTemplates || !bridge.getDefaultOutcomeTemplate) return () => { active = false; };
    void Promise.all([
      bridge.listOutcomeTemplates({ kind: 'word_formatting' }),
      bridge.getDefaultOutcomeTemplate({ kind: 'word_formatting' }),
    ]).then(([rows, defaultRow]) => {
      if (!active) return;
      const parsed = Array.isArray(rows) ? rows.flatMap((row) => { const result = outcomeTemplateRecordSchema.safeParse(row); return result.success ? [result.data] : []; }) : [];
      setTemplates(parsed);
      setDefaultTemplateId(defaultRow && typeof defaultRow === 'object' && 'id' in defaultRow ? String((defaultRow as { id: unknown }).id) : null);
    }).catch(() => { if (active) setNotice('Word 模板列表暂不可用；当前排版编辑不受影响。'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    // The selected document is an external prop; rehydrate the local controls when it changes.
    /* eslint-disable react-hooks/set-state-in-effect -- reset local editor state when the external document prop changes */
    const nextBody = bodyConfigFromDocument(document);
    setBody(nextBody);
    setPage(pageConfigFromDocument(document));
    const preservedStyles = formattingConfigFromDocument(document, nextBody);
    setHeadings(preservedStyles.headings);
    setCaptions(preservedStyles.captions);
    setHeader(document.header);
    setFooter(document.footer);
    setPageNumber(document.page.pageNumber === true);
    setNotice('');
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [document]);

  useEffect(() => {
    if (openRequest <= 0) return;
    /* eslint-disable react-hooks/set-state-in-effect -- open from a Ribbon command */
    setOpen(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [openRequest]);

  const apply = (config: WordFormattingConfig, note: string) => {
    const result = applyWordFormatting(document, config);
    onApply({ ...result.document, header, footer, page: { ...result.document.page, pageNumber } }, note);
    setNotice(result.summary);
  };

  const applyStructured = () => apply({ page, body, headings, captions }, '应用 Word 排版设置');

  const applyInstruction = () => {
    const parsed = parseWordFormattingInstruction(instruction);
    if (parsed.recognized.length === 0) { setNotice(parsed.unsupported[0] ?? '未识别到可执行的排版字段。'); return; }
    const nextBody = { ...body, ...(parsed.config.body ?? {}) };
    const nextPage = { ...page, ...(parsed.config.page ?? {}) };
    setBody(nextBody); setPage(nextPage);
    // Natural language must be additive: only fields the deterministic parser
    // actually recognized may change the document. The merged values above are
    // solely for keeping the structured controls in sync with the instruction.
    apply(parsed.config, `按自然语言排版：${parsed.recognized.join('、')}`);
  };

  const applyTemplate = (template: WordTemplate) => {
    const parsed = WordFormattingTemplateDefinitionSchema.safeParse(template.definition);
    if (!parsed.success) { setNotice(`模板「${template.name}」数据无效，当前文档没有被修改。`); return; }
    const definition = parsed.data;
    const result = applyWordFormatting(document, definition.config);
    const nextBody = { ...body, ...(definition.config.body ?? {}) };
    setBody(nextBody);
    setPage({ ...pageConfigFromDocument(document), ...(definition.config.page ?? {}) });
    setHeadings({ ...headings, ...(definition.config.headings ?? {}) });
    setCaptions({ ...captions, ...(definition.config.captions ?? {}) });
    setHeader(definition.header); setFooter(definition.footer); setPageNumber(definition.pageNumber);
    onApply({ ...result.document, header: definition.header, footer: definition.footer, page: { ...result.document.page, pageNumber: definition.pageNumber } }, `应用 Word 模板「${template.name}」`);
    setSelectedTemplateId(template.id);
    setNotice(`已应用模板「${template.name}」；请保存当前成果版本以持久化排版。`);
  };

  const saveTemplate = async () => {
    const name = templateName.trim();
    if (!name || !window.metis?.saveOutcomeTemplate) { setNotice('请输入模板名称，或检查模板服务是否就绪。'); return; }
    const definition = WordFormattingTemplateDefinitionSchema.safeParse(defaultDefinition(currentConfig(), header, footer, pageNumber));
    if (!definition.success) { setNotice('当前排版参数不满足模板契约，模板没有保存。'); return; }
    try {
      const saved = await window.metis.saveOutcomeTemplate({ kind: 'word_formatting', name, definition: definition.data });
      const parsed = outcomeTemplateRecordSchema.safeParse(saved);
      if (!parsed.success) { setNotice('模板保存未完成，当前文档没有被修改。'); return; }
      setTemplates((rows) => [parsed.data, ...rows.filter((row) => row.id !== parsed.data.id)]);
      setSelectedTemplateId(parsed.data.id); setTemplateName('');
      setNotice(`模板「${parsed.data.name}」已保存。`);
    } catch { setNotice('模板保存请求未完成，当前文档没有被修改。'); }
  };

  const renameTemplate = async () => {
    const name = templateName.trim();
    if (!selectedTemplateId || !name || !window.metis?.updateOutcomeTemplate) return;
    try {
      const saved = await window.metis.updateOutcomeTemplate({ id: selectedTemplateId, kind: 'word_formatting', name });
      const parsed = outcomeTemplateRecordSchema.safeParse(saved);
      if (!parsed.success) { setNotice('模板重命名未完成。'); return; }
      setTemplates((rows) => rows.map((row) => row.id === parsed.data.id ? parsed.data : row)); setTemplateName(''); setNotice(`模板已重命名为「${parsed.data.name}」。`);
    } catch { setNotice('模板重命名请求未完成。'); }
  };

  const updateTemplate = async () => {
    if (!selectedTemplateId || !window.metis?.updateOutcomeTemplate) return;
    const definition = WordFormattingTemplateDefinitionSchema.safeParse(defaultDefinition(currentConfig(), header, footer, pageNumber));
    if (!definition.success) { setNotice('当前排版参数不满足模板契约，模板没有更新。'); return; }
    try {
      const saved = await window.metis.updateOutcomeTemplate({ id: selectedTemplateId, kind: 'word_formatting', definition: definition.data });
      const parsed = outcomeTemplateRecordSchema.safeParse(saved);
      if (!parsed.success) { setNotice('模板更新未完成。'); return; }
      setTemplates((rows) => rows.map((row) => row.id === parsed.data.id ? parsed.data : row)); setNotice(`模板「${parsed.data.name}」已更新为当前排版。`);
    } catch { setNotice('模板更新请求未完成。'); }
  };

  const deleteTemplate = async () => {
    if (!pendingDeleteId || !window.metis?.deleteOutcomeTemplate) return;
    try {
      const ok = await window.metis.deleteOutcomeTemplate({ id: pendingDeleteId, kind: 'word_formatting' });
      if (!ok) { setNotice('模板删除未完成。'); return; }
      setTemplates((rows) => rows.filter((row) => row.id !== pendingDeleteId));
      if (defaultTemplateId === pendingDeleteId) setDefaultTemplateId(null);
      if (selectedTemplateId === pendingDeleteId) setSelectedTemplateId('');
      setPendingDeleteId(null); setNotice('模板已删除。');
    } catch { setNotice('模板删除请求未完成。'); }
  };

  const setDefault = async () => {
    if (!selectedTemplateId || !window.metis?.setDefaultOutcomeTemplate) return;
    try {
      const ok = await window.metis.setDefaultOutcomeTemplate({ kind: 'word_formatting', templateId: selectedTemplateId });
      if (ok) { setDefaultTemplateId(selectedTemplateId); setNotice('已设为 Word 新建成果默认模板。'); } else setNotice('默认模板设置未完成。');
    } catch { setNotice('默认模板设置请求未完成。'); }
  };

  const clearDefault = async () => {
    if (!defaultTemplateId || !window.metis?.setDefaultOutcomeTemplate) return;
    try {
      const ok = await window.metis.setDefaultOutcomeTemplate({ kind: 'word_formatting', templateId: null });
      if (ok) { setDefaultTemplateId(null); setNotice('已取消 Word 新建成果默认模板。'); } else setNotice('默认模板取消未完成。');
    } catch { setNotice('默认模板取消请求未完成。'); }
  };

  // 从上传的 docx 模板解析排版规则：主进程选文件→解析，这里只做预览与确认。
  const importTemplate = async () => {
    if (!window.metis?.parseWordTemplateStyle) { setNotice('模板导入服务尚未就绪。'); return; }
    setImporting(true);
    try {
      const result = await window.metis.parseWordTemplateStyle();
      if (!result.ok) {
        setNotice(result.code === 'cancelled' ? '' : (result.message ?? '模板解析未完成。'));
        return;
      }
      if (!result.config) { setNotice('模板里没有可识别的排版规则。'); return; }
      setImportedTemplate({ fileName: result.fileName ?? '模板', config: result.config as WordFormattingConfig, recognized: result.recognized ?? [], unrecognized: result.unrecognized ?? [] });
      setImportedTemplateName('');
    } catch { setNotice('模板导入请求未完成。'); }
    finally { setImporting(false); }
  };

  const applyImportedTemplate = async (saveAsTemplate: boolean) => {
    if (!importedTemplate) return;
    const result = applyWordFormatting(document, importedTemplate.config);
    const config = importedTemplate.config;
    // 同步结构化控件，让面板显示与文档一致的规则。
    if (config.page) setPage({ ...page, ...config.page });
    if (config.body) setBody({ ...body, ...config.body });
    if (config.headings) setHeadings({ ...headings, ...config.headings });
    if (config.captions) setCaptions({ ...captions, ...config.captions });
    // 页眉页脚属于模板内容而非版式规则，按设计不迁移，保留当前值。
    onApply({ ...result.document, header, footer, page: { ...result.document.page, pageNumber } }, `应用模板「${importedTemplate.fileName}」排版`);
    setNotice(`已按「${importedTemplate.fileName}」排版${importedTemplate.unrecognized.length > 0 ? `；${importedTemplate.unrecognized.length} 项无法映射的规则未应用` : ''}。请保存成果版本以持久化。`);
    if (saveAsTemplate) {
      const name = importedTemplateName.trim() || importedTemplate.fileName.replace(/\.docx$/iu, '');
      if (window.metis?.saveOutcomeTemplate) {
        const definition = WordFormattingTemplateDefinitionSchema.safeParse(defaultDefinition(config, header, footer, pageNumber));
        if (definition.success) {
          try {
            const saved = await window.metis.saveOutcomeTemplate({ kind: 'word_formatting', name, definition: definition.data });
            const parsed = outcomeTemplateRecordSchema.safeParse(saved);
            if (parsed.success) {
              setTemplates((rows) => [parsed.data, ...rows.filter((row) => row.id !== parsed.data.id)]);
              setSelectedTemplateId(parsed.data.id);
              setNotice((current) => `${current} 模板「${name}」已保存，可复用。`);
            }
          } catch { /* 保存失败不影响已应用的排版 */ }
        }
      }
    }
    setImportedTemplate(null);
  };

  // 从投稿要求/规范文本解析排版规则：确定性引擎优先，主进程 AI 只兜底并逐条核对原文。
  const parseGuideline = async () => {
    if (!window.metis?.parseFormattingFromText) { setNotice('规范解析服务尚未就绪。'); return; }
    if (guidelineText.trim().length < 20) { setNotice('请粘贴至少 20 字的投稿要求或排版规范。'); return; }
    setParsingGuideline(true);
    try {
      const result = await window.metis.parseFormattingFromText(guidelineText);
      if (!result.ok || !result.config) { setNotice(result.message ?? '规范解析未完成。'); return; }
      const recognized = result.matched ?? [];
      const unclear = [...(result.unclear ?? [])];
      if (result.note) unclear.push(result.note);
      if (recognized.length === 0) { setNotice('没有从文本中识别出可执行的排版规则。'); return; }
      setImportedTemplate({ fileName: '投稿要求', config: result.config as WordFormattingConfig, recognized, unrecognized: unclear });
      setImportedTemplateName('');
    } catch { setNotice('规范解析请求未完成。'); }
    finally { setParsingGuideline(false); }
  };

  const selectedTemplate = useMemo(() => templates.find((row) => row.id === selectedTemplateId), [selectedTemplateId, templates]);

  return <>
    {!hideTrigger && <button className="word-toolbar__format" type="button" onClick={() => setOpen(true)} title="打开排版设置">
      <SlidersHorizontal size={15} />排版
    </button>}
    {open && <div className="outcome-word-format-backdrop" role="presentation">
      <section className="outcome-word-format-panel" role="dialog" aria-modal="true" aria-label="Word 排版设置">
        <header>
          <div><span><LayoutPanelTop size={17} /></span><div><strong>Word 排版</strong><small>设置会写入当前成果；请保存版本后导出。</small></div></div>
          <button type="button" onClick={() => setOpen(false)} aria-label="关闭排版设置"><X size={16} /></button>
        </header>
        <section className="outcome-word-format-panel__templates" aria-label="Word 排版模板">
          <label>{t('outcomeWordFormatting.templates.fieldLabel')}<select aria-label="选择 Word 排版模板" value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}><option value="">{t('outcomeWordFormatting.templates.selectSaved')}</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}{template.id === defaultTemplateId ? t('outcomeWordFormatting.templates.defaultSuffix') : ''}</option>)}</select></label>
          <div className="outcome-word-format-panel__template-actions"><button type="button" onClick={() => selectedTemplate && applyTemplate(selectedTemplate)} disabled={!selectedTemplate}>{t('outcomeWordFormatting.templates.apply')}</button><input aria-label={t('outcomeWordFormatting.templates.nameLabel')} value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder={t('outcomeWordFormatting.templates.namePlaceholder')} /><button type="button" onClick={() => void saveTemplate()}>{t('outcomeWordFormatting.templates.saveAs')}</button><button type="button" onClick={() => void importTemplate()} disabled={importing} title="选择一份 .docx 模板，读取其字体字号行距页边距等排版规则">{importing ? '解析中…' : '从文件导入模板'}</button><button type="button" onClick={() => void renameTemplate()} disabled={!selectedTemplate}>{t('outcomeWordFormatting.templates.rename')}</button><button type="button" onClick={() => void updateTemplate()} disabled={!selectedTemplate}>{t('outcomeWordFormatting.templates.updateCurrent')}</button><button type="button" onClick={() => void setDefault()} disabled={!selectedTemplate}>{t('outcomeWordFormatting.templates.setDefault')}</button><button type="button" onClick={() => void clearDefault()} disabled={!defaultTemplateId}>{t('outcomeWordFormatting.templates.clearDefault')}</button><button type="button" onClick={() => setPendingDeleteId(selectedTemplateId)} disabled={!selectedTemplate}>{t('outcomeWordFormatting.templates.delete')}</button></div>
          {importedTemplate && <div className="outcome-word-format-panel__template-confirm" role="alert" aria-label="模板解析预览">
            <strong>模板「{importedTemplate.fileName}」解析结果</strong>
            {importedTemplate.recognized.length > 0
              ? <ul>{importedTemplate.recognized.map((rule) => <li key={rule}>{rule}</li>)}</ul>
              : <p>未识别到可安全迁移的排版规则。</p>}
            {importedTemplate.unrecognized.length > 0 && <p>以下内容不会迁移：{importedTemplate.unrecognized.join('；')}</p>}
            <input aria-label="保存模板名称" value={importedTemplateName} onChange={(event) => setImportedTemplateName(event.target.value)} placeholder="模板名称（可选，用于复用）" />
            <button className="primary" type="button" onClick={() => void applyImportedTemplate(true)}>应用并保存模板</button>
            <button type="button" onClick={() => void applyImportedTemplate(false)}>仅应用</button>
            <button type="button" onClick={() => setImportedTemplate(null)}>取消</button>
          </div>}
          {pendingDeleteId && <div className="outcome-word-format-panel__template-confirm" role="alert"><span>{t('outcomeWordFormatting.templates.confirmDelete')}</span><button type="button" onClick={() => void deleteTemplate()}>{t('outcomeWordFormatting.templates.confirm')}</button><button type="button" onClick={() => setPendingDeleteId(null)}>{t('outcomeWordFormatting.templates.cancel')}</button></div>}
        </section>
        <section className="outcome-word-format-panel__instruction">
          <label htmlFor="word-format-instruction">自然语言要求</label>
          <div><input id="word-format-instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：宋体，小四，1.5 倍行距，首行缩进 2 字符" /><button type="button" onClick={applyInstruction}>解析并应用</button></div>
          <p>仅执行可明确识别的纸张、字体、字号、对齐、行距、缩进和页边距；其余要求会保留给你继续设置。</p>
        </section>
        <section className="outcome-word-format-panel__instruction">
          <label htmlFor="word-format-guideline">从投稿要求生成</label>
          <div><textarea id="word-format-guideline" aria-label="投稿要求文本" value={guidelineText} onChange={(event) => setGuidelineText(event.target.value)} rows={4} placeholder="粘贴期刊投稿要求或论文格式规范整段文字，例如：正文用宋体小四，1.5倍行距，首行缩进2字符；页边距上下2.5cm，左右3cm…" /></div>
          <div className="outcome-word-format-panel__instruction-actions"><button type="button" onClick={() => void parseGuideline()} disabled={parsingGuideline}>{parsingGuideline ? '解析中…' : '解析规范并生成排版'}</button></div>
          <p>支持字体、中文字号、行距、首行缩进、对齐与页边距；解析结果会先列出识别清单，确认后才应用。</p>
        </section>
        <div className="outcome-word-format-panel__grid">
          <fieldset><legend>页面</legend>
            <label>纸张<select value={page.paper ?? 'A4'} onChange={(event) => setPage({ ...page, paper: event.target.value as PageConfig['paper'] })}><option value="A4">A4</option><option value="Letter">Letter</option><option value="custom">自定义（保留导入尺寸）</option></select></label>
            <label>上/下边距（cm）<input aria-label="上边距" type="number" min="0" max="10" step="0.01" value={page.marginTopCm ?? 2.54} onChange={(event) => { const value = numberValue(event.target.value, 2.54); setPage({ ...page, marginTopCm: value, marginBottomCm: value }); }} /></label>
            <label>左/右边距（cm）<input aria-label="左边距" type="number" min="0" max="10" step="0.01" value={page.marginLeftCm ?? 3.17} onChange={(event) => { const value = numberValue(event.target.value, 3.17); setPage({ ...page, marginLeftCm: value, marginRightCm: value }); }} /></label>
            <label className="outcome-word-format-panel__checkbox"><input aria-label="页码" type="checkbox" checked={pageNumber} onChange={(event) => setPageNumber(event.target.checked)} />页脚显示页码</label>
          </fieldset>
          <fieldset><legend>正文</legend>
            <label>字体<input aria-label="正文字体" value={body.fontFamily ?? ''} onChange={(event) => setBody({ ...body, fontFamily: event.target.value })} /></label>
            <label>字号（pt）<input aria-label="正文字号" type="number" min="6" max="96" step="0.5" value={body.fontSizePt ?? 12} onChange={(event) => setBody({ ...body, fontSizePt: numberValue(event.target.value, 12) })} /></label>
            <label>对齐<select aria-label="正文对齐" value={body.align ?? 'justify'} onChange={(event) => setBody({ ...body, align: event.target.value as BodyConfig['align'] })}><option value="justify">两端对齐</option><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
            <label>行距<input aria-label="正文行距" type="number" min="0.5" max="4" step="0.1" value={body.lineSpacing ?? 1.5} onChange={(event) => setBody({ ...body, lineSpacing: numberValue(event.target.value, 1.5) })} /></label>
            <label>首行缩进（字）<input aria-label="首行缩进" type="number" min="0" max="16" step="0.5" value={body.firstLineIndentChars ?? 2} onChange={(event) => setBody({ ...body, firstLineIndentChars: numberValue(event.target.value, 2) })} /></label>
          </fieldset>
        </div>
        <section className="outcome-word-format-panel__page-furniture"><label>页眉<input aria-label="页眉" value={header} onChange={(event) => setHeader(event.target.value)} placeholder="例如：研究报告" /></label><label>页脚<input aria-label="页脚" value={footer} onChange={(event) => setFooter(event.target.value)} placeholder="例如：METIS · 草稿" /></label></section>
        {notice && <p className="outcome-word-format-panel__notice" role="status">{notice}</p>}
        <footer><button type="button" onClick={() => setOpen(false)}>返回编辑</button><button className="primary" type="button" onClick={applyStructured}>应用结构化排版</button></footer>
      </section>
    </div>}
  </>;
}
