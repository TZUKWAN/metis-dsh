import path from 'node:path';

export function resolveGenofficeRoot(input: {
  isPackaged: boolean;
  resourcesPath: string;
  envRoot?: string;
  devCandidates: readonly string[];
}): string {
  if (input.isPackaged) return path.join(path.resolve(input.resourcesPath), 'genoffice');
  const candidates = [input.envRoot?.trim(), ...input.devCandidates]
    .filter((candidate): candidate is string => Boolean(candidate));
  return candidates[0] ?? path.join(path.resolve(input.resourcesPath), 'genoffice');
}

export function genofficeElectronPath(root: string): string {
  return path.join(root, 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron');
}

const SAFE_PARENT_ENVIRONMENT = [
  'APPDATA',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'PATH',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
] as const;

export function buildGenofficeEnvironment(
  parent: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  const allowed = new Set(SAFE_PARENT_ENVIRONMENT.map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(parent)) {
    if (allowed.has(name.toLowerCase()) && typeof value === 'string' && value.length > 0) {
      environment[name] = value;
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value.length > 0) environment[name] = value;
  }
  return environment;
}
