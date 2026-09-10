/**
 * CsvTable — 轻量 CSV 解析（T21 配套）。
 *
 * 支持引号字段、逗号/制表符分隔、表头映射、数值列推断。
 * 确定性解析，供统计引擎与数据导入使用。
 */

export interface ParsedTable {
  columns: string[];
  rows: Array<Record<string, string | number>>;
  /** 每列是否为数值列。 */
  numericColumns: Record<string, boolean>;
}

export function parseCsv(text: string, delimiter?: string): ParsedTable {
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? '';
  const detected = delimiter ?? (firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',');
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === detected) {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      record.push(field);
      field = '';
      if (record.some((value) => value.trim() !== '')) records.push(record);
      record = [];
    } else {
      field += char;
    }
  }
  record.push(field);
  if (record.some((value) => value.trim() !== '')) records.push(record);

  if (records.length === 0) return { columns: [], rows: [], numericColumns: {} };
  const columns = records[0]!.map((name, index) => name.trim() || `col${index + 1}`);
  const dataRows = records.slice(1);
  const numericColumns: Record<string, boolean> = {};
  for (const column of columns) {
    const values = dataRows.map((row) => row[columns.indexOf(column)]?.trim() ?? '');
    const nonEmpty = values.filter((value) => value !== '');
    numericColumns[column] = nonEmpty.length > 0 && nonEmpty.every((value) => /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/u.test(value));
  }
  const rows = dataRows.map((row) => {
    const entry: Record<string, string | number> = {};
    columns.forEach((column, index) => {
      const raw = (row[index] ?? '').trim();
      entry[column] = numericColumns[column] && raw !== '' ? Number(raw) : raw;
    });
    return entry;
  });
  return { columns, rows, numericColumns };
}

/** 提取数值列（供 describe/ols）。 */
export function numericColumn(table: ParsedTable, column: string): number[] {
  return table.rows
    .map((row) => row[column])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .map((value) => value as number);
}
