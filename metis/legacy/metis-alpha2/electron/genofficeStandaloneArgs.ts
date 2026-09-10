import path from 'node:path';

export type GenofficeStandaloneArgs = Readonly<{
  entry: string;
  filePath?: string;
}>;

const EDITOR_ENTRY = /[\\/]apps[\\/](?:docs|slides|sheets|pdf)[\\/]out[\\/]main[\\/]index\.js$/iu;
const DOCUMENT = /\.(?:docx|pptx|xlsx|xlsm|pdf)$/iu;

export function parseGenofficeStandaloneArgs(argv: readonly string[]): GenofficeStandaloneArgs {
  const entryIndex = argv.findIndex((value) => EDITOR_ENTRY.test(value));
  if (entryIndex < 0) throw new Error('GenOffice standalone editor entry is missing.');
  const entry = path.resolve(argv[entryIndex]!);
  const filePath = argv.slice(entryIndex + 1).find((value) => DOCUMENT.test(value));
  return filePath ? { entry, filePath: path.resolve(filePath) } : { entry };
}
