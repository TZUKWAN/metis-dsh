export const GENOFFICE_READY_PREFIX = 'METIS_GENOFFICE_READY ';

export type GenofficeReadyMessage = Readonly<{
  entry: string;
  filePath: string | null;
  editorReady: boolean;
}>;

export function encodeGenofficeReadyMessage(message: GenofficeReadyMessage): string {
  return `${GENOFFICE_READY_PREFIX}${JSON.stringify(message)}\n`;
}

export function parseGenofficeReadyLine(line: string): GenofficeReadyMessage | undefined {
  if (!line.startsWith(GENOFFICE_READY_PREFIX)) return undefined;
  try {
    const value = JSON.parse(line.slice(GENOFFICE_READY_PREFIX.length)) as Record<string, unknown>;
    if (typeof value.entry !== 'string' || !value.entry) return undefined;
    if (value.filePath !== null && typeof value.filePath !== 'string') return undefined;
    if (value.editorReady !== true) return undefined;
    return { entry: value.entry, filePath: value.filePath as string | null, editorReady: true };
  } catch {
    return undefined;
  }
}
