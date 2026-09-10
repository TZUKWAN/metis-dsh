/**
 * LaTeX log parser — extracts errors and warnings from pdflatex output.
 */

export interface LatexLogEntry {
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Parse a LaTeX compilation log and return structured errors/warnings.
 */
export function parseLatexLog(stdout: string): LatexLogEntry[] {
  const errors: LatexLogEntry[] = [];
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const errMatch = line.match(/^! (.+)/);
    if (errMatch) {
      // Line number often appears on the next line as "l.25 ..."
      let lineNum = 0;
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const nextLine = lines[j] ?? '';
        const lineMatch = nextLine.match(/^l\.(\d+)/);
        if (lineMatch?.[1]) {
          lineNum = parseInt(lineMatch[1], 10);
          break;
        }
      }
      errors.push({
        line: lineNum,
        message: errMatch[1] ?? 'Unknown error',
        severity: 'error',
      });
    }
    const warnMatch = line.match(/LaTeX Warning: (.+)/);
    if (warnMatch) {
      errors.push({ line: 0, message: warnMatch[1] ?? 'Warning', severity: 'warning' });
    }
  }
  return errors;
}
