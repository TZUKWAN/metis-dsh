import fs from 'node:fs';
import JSZip from 'jszip';
import { parseSpreadsheetWorkbook, DEFAULT_XLSX_BUDGETS } from './OutcomeExternalEditorBridge.js';

/**
 * 参考材料文本抽取器（2026-09-01 刘总要求）：
 *  - PPTX：逐页读取 ppt/slides/slideN.xml 的 <a:t> 文本运行；
 *  - XLSX/XLSM：复用发布级电子表解析器，工作表 → 行列表格文本；
 *  - 旧版二进制 .ppt 无可靠抽取器，由调用方如实提示转存为 .pptx。
 */

function decodeXmlTextRun(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export async function extractPptxText(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((left, right) => {
      const num = (name: string) => Number(/slide(\d+)\.xml$/u.exec(name)?.[1] ?? 0);
      return num(left) - num(right);
    });
  if (slideNames.length === 0) throw new Error('pptx_slides_missing');
  const pages: string[] = [];
  for (let index = 0; index < slideNames.length; index += 1) {
    const xml = await zip.files[slideNames[index]!]!.async('string');
    const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/gu)].map((match) => decodeXmlTextRun(match[1] ?? ''));
    const joined = runs.filter(Boolean).join('\n').trim();
    if (joined) pages.push(`【第 ${index + 1} 页】\n${joined}`);
  }
  const text = pages.join('\n\n').trim();
  if (text.length < 20) throw new Error('material_too_short');
  return text;
}

export async function extractXlsxText(filePath: string): Promise<string> {
  const bytes = fs.readFileSync(filePath);
  const workbook = await parseSpreadsheetWorkbook(bytes, DEFAULT_XLSX_BUDGETS);
  const parts: string[] = [];
  for (const sheetName of workbook.sheetNames) {
    const cellsByAddress = Object.entries(workbook.cells)
      .filter(([address]) => address.startsWith(`${sheetName}!`))
      .map(([address, cell]) => {
        const match = /([A-Z]+)(\d+)$/u.exec(address);
        const columnLetters = match?.[1] ?? 'A';
        let columnIndex = 0;
        for (const char of columnLetters) columnIndex = columnIndex * 26 + (char.charCodeAt(0) - 64);
        const value = cell?.value ?? '';
        return { row: Number(match?.[2] ?? 0), columnIndex, value: value === null ? '' : String(value) };
      })
      .filter((cell) => cell.value.trim().length > 0)
      .sort((left, right) => left.row - right.row || left.columnIndex - right.columnIndex);
    if (cellsByAddress.length === 0) continue;
    parts.push(`【工作表：${sheetName}】`);
    let currentRow = -1;
    let line = '';
    for (const cell of cellsByAddress) {
      if (cell.row !== currentRow) {
        if (line) parts.push(line.replace(/\t$/, ''));
        line = '';
        currentRow = cell.row;
      }
      line += `${cell.value}\t`;
    }
    if (line) parts.push(line.replace(/\t$/, ''));
  }
  const text = parts.join('\n').trim();
  if (text.length < 20) throw new Error('material_too_short');
  return text;
}
