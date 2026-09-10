import { describe, expect, it } from 'vitest';
import { parseGenofficeStandaloneArgs } from '../../electron/genofficeStandaloneArgs.js';
import { encodeGenofficeReadyMessage, parseGenofficeReadyLine } from '../../electron/genofficeStandaloneProtocol.js';
import { buildGenofficeEnvironment, genofficeElectronPath, resolveGenofficeRoot } from '../../electron/genofficeRuntimePaths.js';

describe('GenOffice standalone wrapper arguments', () => {
  it('ignores Electron switches before the wrapper and finds the editor entry and file', () => {
    expect(parseGenofficeStandaloneArgs([
      'electron.exe',
      '--user-data-dir=C:\\Temp\\profile',
      '--remote-debugging-port=9310',
      'genofficeStandaloneWrapper.js',
      'D:\\tools\\genoffice\\apps\\docs\\out\\main\\index.js',
      'D:\\data\\paper.docx',
    ])).toEqual({
      entry: 'D:\\tools\\genoffice\\apps\\docs\\out\\main\\index.js',
      filePath: 'D:\\data\\paper.docx',
    });
  });

  it('round-trips a bounded readiness message from the standalone host', () => {
    const line = encodeGenofficeReadyMessage({ entry: 'D:\\docs\\out\\main\\index.js', filePath: 'D:\\paper.docx', editorReady: true }).trim();
    expect(parseGenofficeReadyLine(line)).toEqual({ entry: 'D:\\docs\\out\\main\\index.js', filePath: 'D:\\paper.docx', editorReady: true });
    expect(parseGenofficeReadyLine('not-ready')).toBeUndefined();
    expect(parseGenofficeReadyLine('METIS_GENOFFICE_READY {"entry":""}')).toBeUndefined();
  });

  it('uses the packaged resources directory instead of a workspace-relative GenOffice tree', () => {
    const root = resolveGenofficeRoot({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\Metis\\resources',
      envRoot: 'D:\\workspace\\tools\\genoffice',
      devCandidates: ['D:\\workspace\\tools\\genoffice'],
    });
    expect(root).toBe('C:\\Program Files\\Metis\\resources\\genoffice');
    expect(genofficeElectronPath(root)).toBe(`C:\\Program Files\\Metis\\resources\\genoffice\\electron\\${process.platform === 'win32' ? 'electron.exe' : 'electron'}`);
  });

  it('does not forward provider credentials into the GenOffice child environment', () => {
    const environment = buildGenofficeEnvironment({
      PATH: 'C:\\Windows\\System32',
      SYSTEMROOT: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      OPENAI_API_KEY: 'must-not-cross',
      METIS_PARENT_SECRET: 'must-not-cross',
      AWS_SECRET_ACCESS_KEY: 'must-not-cross',
    }, { GENOFFICE_USER_DATA: 'C:\\Temp\\genoffice', GENOFFICE_DISABLE_CLOUD: '1' });
    expect(environment).toMatchObject({ PATH: 'C:\\Windows\\System32', SYSTEMROOT: 'C:\\Windows', GENOFFICE_DISABLE_CLOUD: '1' });
    expect(environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(environment).not.toHaveProperty('METIS_PARENT_SECRET');
    expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });
});
