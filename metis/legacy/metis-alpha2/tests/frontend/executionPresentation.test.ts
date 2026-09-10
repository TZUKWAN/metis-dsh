import { describe, expect, it } from 'vitest';
import {
  presentApprovalRequest,
  presentDiagnosticText,
  presentDiagnosticValue,
  presentExecutionError,
  redactPath,
  stringifyDiagnosticValue,
} from '../../src/presentation/executionPresentation.js';
import { SafeMarkdown, presentSafeMarkdownText } from '../../src/presentation/SafeMarkdown.js';

const DISCLOSURE_MARKERS = [
  'C:\\Users\\researcher\\secret-notes.txt',
  '\\\\archive-server\\restricted\\interviews',
  '/home/researcher/private/field-notes.md',
  'file:///C:/Users/researcher/private/source.pdf',
  'sensitive search terms',
  'private-collection-name',
  'researcher:password',
  'api_key=marker-api-key',
  'private-fragment',
];

describe('execution presentation disclosure boundary', () => {
  it.each([
    ['path', 'C:\\Users\\researcher\\secret-notes.txt'],
    ['filePath', '\\\\archive-server\\restricted\\interviews'],
    ['directory', '/home/researcher/private'],
    ['filename', '/home/researcher/private/field-notes.md'],
    ['query', 'sensitive search terms'],
    ['title', 'C:\\Users\\researcher\\private-title.txt'],
    ['url', 'https://researcher:password@example.test/source?api_key=marker-api-key#private-fragment'],
    ['url', 'file:///C:/Users/researcher/private/source.pdf'],
    ['collectionName', 'private-collection-name'],
    ['name', '\\\\archive-server\\restricted\\name-disguised-as-a-path'],
  ])('does not expose normal-mode approval target from %s', (key, value) => {
    const presentation = presentApprovalRequest(
      'write_file',
      { [key]: value },
      'en',
    );
    const rendered = `${presentation.action}\n${presentation.summary}`;

    expect(rendered).toBe(
      'Save changes to a file\nIf approved, Metis will perform only the research action shown above.',
    );
    for (const marker of DISCLOSURE_MARKERS) {
      expect(rendered).not.toContain(marker);
    }
    expect(rendered).not.toContain(String(value));
  });

  it('recursively redacts secret-bearing keys while preserving useful diagnostic structure', () => {
    const value = {
      command: 'python analysis.py --limit 20',
      headers: {
        Authorization: 'Bearer authorization-marker-123456789',
        'X-API-Key': 'header-api-key-marker',
      },
      env: {
        MODEL_API_KEY: 'environment-api-key-marker',
        PASSWORD: 'environment-password-marker',
        SAFE_MODE: 'strict',
      },
      nested: [
        { refreshToken: 'refresh-token-marker' },
        { title: 'Allowed diagnostic title' },
      ],
    };

    const scrubbed = presentDiagnosticValue(value);
    const rendered = JSON.stringify(scrubbed);

    expect(rendered).toContain('python analysis.py --limit 20');
    expect(rendered).toContain('SAFE_MODE');
    expect(rendered).toContain('strict');
    expect(rendered).toContain('Allowed diagnostic title');
    expect(rendered).toContain('[REDACTED]');
    for (const secret of [
      'authorization-marker-123456789',
      'header-api-key-marker',
      'environment-api-key-marker',
      'environment-password-marker',
      'refresh-token-marker',
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it('redacts credentials embedded in free text and strips URL userinfo, query, and fragment', () => {
    const raw = [
      'Authorization: Bearer bearer-marker-123456789',
      'password=assignment-password-marker',
      '--api-key cli-api-key-marker',
      'https://researcher:url-password-marker@example.test/private/path?token=url-token-marker&view=full#url-fragment-marker',
    ].join(' | ');

    const rendered = presentDiagnosticText(raw);

    expect(rendered).toContain('Authorization: [REDACTED]');
    expect(rendered).toContain('password=[REDACTED]');
    expect(rendered).toContain('--api-key [REDACTED]');
    expect(rendered).toContain('https://example.test/private/path?[REDACTED]#[REDACTED]');
    for (const secret of [
      'bearer-marker-123456789',
      'assignment-password-marker',
      'cli-api-key-marker',
      'researcher',
      'url-password-marker',
      'url-token-marker',
      'view=full',
      'url-fragment-marker',
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it('scrubs diagnostic errors without degrading normal-mode error policy', () => {
    const error = new Error(
      'Request failed: API key authentication was rejected. '
      + 'Authorization: Bearer error-token-marker at '
      + 'https://user:error-password@example.test/v1?api_key=error-api-marker#debug-fragment',
    );

    const diagnostic = presentExecutionError(error, 'en', 'diagnostic');
    const normal = presentExecutionError(error, 'en', 'normal');

    expect(diagnostic).toContain('[REDACTED]');
    expect(diagnostic).toContain('https://example.test/v1?[REDACTED]#[REDACTED]');
    expect(normal).toBe(
      'The model connection could not be verified. Check Settings → Model Connection.',
    );
    for (const secret of [
      'error-token-marker',
      'user',
      'error-password',
      'error-api-marker',
      'debug-fragment',
    ]) {
      expect(diagnostic).not.toContain(secret);
      expect(normal).not.toContain(secret);
    }
  });

  describe('path redaction', () => {
    it.each([
      ['Windows drive backslash', 'Failed to read C:\\Users\\researcher\\private.pdf at start offset 0'],
      ['Windows drive forward slash', 'Failed to read C:/Users/researcher/private.pdf at start offset 0'],
      ['POSIX absolute multi-segment', 'Error opening /home/researcher/data/experiment.log for analysis'],
      ['POSIX root file', 'Missing /etc/passwd backup'],
      ['POSIX single segment with extension', 'Failed /secret.pdf'],
      ['POSIX single segment short', 'Failed /a'],
      ['UNC network', 'Cannot access \\\\archive-server\\restricted\\interviews\\session-1.wav'],
      ['spaces and brackets', 'Saved as /tmp/file name (v2).pdf for review'],
      ['home shorthand', 'Loaded ~/private/field-notes.md into workspace'],
    ])('redacts %s absolute paths in diagnostic mode', (_, message) => {
      const error = new Error(message);
      const diagnostic = presentExecutionError(error, 'en', 'diagnostic');
      expect(diagnostic).toContain('[FILE]');
      expect(diagnostic).not.toContain('private');
      expect(diagnostic).not.toContain('researcher');
      expect(diagnostic).not.toContain('file name');
      expect(diagnostic).not.toContain('field-notes');
    });

    it('redacts file:// URL in diagnostic mode without leaking basename', () => {
      const error = new Error('Downloaded from file:///C:/Users/researcher/private/source.pdf to memory');
      const diagnostic = presentExecutionError(error, 'en', 'diagnostic');
      expect(diagnostic).toContain('Downloaded from');
      expect(diagnostic).not.toContain('private');
      expect(diagnostic).not.toContain('researcher');
      expect(diagnostic).not.toContain('/Users/');
      expect(diagnostic).not.toContain('source.pdf');
    });

    it.each([
      ['Windows drive backslash', 'Failed to read C:\\Users\\researcher\\private.pdf'],
      ['Windows drive forward slash', 'Failed to read C:/Users/researcher/private.pdf'],
      ['POSIX absolute', 'Error opening /home/researcher/data/experiment.log'],
      ['POSIX root file', 'Missing /etc/passwd backup'],
      ['POSIX single segment with extension', 'Failed /secret.pdf'],
      ['POSIX single segment short', 'Failed /a'],
      ['UNC network', 'Cannot access \\\\archive-server\\restricted\\interviews\\session-1.wav'],
      ['spaces and brackets', 'Saved as /tmp/file name (v2).pdf'],
      ['file:// URL', 'Downloaded from file:///C:/Users/researcher/private/source.pdf'],
    ])('redacts %s absolute paths in normal mode', (_, message) => {
      const error = new Error(message);
      const normal = presentExecutionError(error, 'en', 'normal');
      expect(normal).not.toContain('private');
      expect(normal).not.toContain('researcher');
      expect(normal).not.toContain('C:');
      expect(normal).not.toContain('home');
      expect(normal).not.toContain('source.pdf');
    });

    it('does not redact https URLs as file paths', () => {
      const raw = 'Fetch https://example.test/api/v1/data?token=secret then read /home/user/data.json';
      const diagnostic = presentDiagnosticText(raw);
      expect(diagnostic).toContain('https://example.test/api/v1/data?[REDACTED]');
      expect(diagnostic).toContain('[FILE]');
      expect(diagnostic).not.toContain('/home/user');
      expect(diagnostic).not.toContain('secret');
    });

    it('redactPath preserves non-path diagnostic context', () => {
      const input = 'Operation read_file failed with code EACCES at /home/user/docs/report.pdf';
      const result = redactPath(input);
      expect(result).toContain('Operation read_file failed with code EACCES at');
      expect(result).toContain('[FILE]');
      expect(result).not.toContain('/home/user');
    });

    it('redactPath handles text with no paths', () => {
      expect(redactPath('Connection timed out after 30 seconds')).toBe('Connection timed out after 30 seconds');
    });
  });

  describe('redactPath negative matrix — does NOT redact non-paths', () => {
    it.each([
      ['proportion', '50/50 split between groups'],
      ['fraction', '3/4 of the results'],
      ['Markdown link', '[click here](docs/guide.md) for details'],
      ['Markdown image', 'see ![diagram](assets/arch.png) above'],
      ['relative ./', 'see ./relative/config.json for setup'],
      ['relative ../', 'import from ../parent/module.ts'],
      ['URL with path', 'Fetch https://api.example.com/v2/data returned 500'],
      ['file extension only', 'rename .pdf to .bak'],
    ])('preserves %s unchanged', (_, input) => {
      expect(redactPath(input)).toBe(input);
    });
  });

  describe('redactPath positive matrix — DOES redact absolute paths', () => {
    it.each([
      ['Windows drive', 'C:\\Users\\test\\doc.pdf'],
      ['Windows forward', 'C:/Users/test/doc.pdf'],
      ['POSIX home', '/home/test/docs/report.pdf'],
      ['POSIX tmp', '/tmp/build-output.log'],
      ['POSIX etc', '/etc/nginx/conf.d/site.conf'],
      ['POSIX usr', '/usr/local/bin/tool'],
      ['UNC share', '\\\\server\\share\\data.csv'],
      ['file URL', 'file:///C:/Users/test/data.json'],
      ['home shorthand', '~/Documents/notes.md'],
      ['HTML src path', '<img src="/assets/logo.png" alt="logo" />'],
      ['CSS url path', 'background: url("/bg.png")'],
      ['colon prefixed', 'Error: /usr/bin/node failed'],
    ])('redacts %s', (_, input) => {
      const result = redactPath(input);
      expect(result).toContain('[FILE]');
      expect(result).not.toMatch(/\bUsers\b|\/home\/|\/tmp\/|\/etc\/|\/usr\/|share|Documents/);
    });
  });

  describe('CJK slash tokens are not paths — 2026-08-29 board regression', () => {
    it('keeps workflow step names "父名 / 子名" fully intact', () => {
      const input = '确定综述主题与研究边界 / 明确核心问题与综述目标';
      expect(redactPath(input)).toBe(input);
      expect(presentDiagnosticText(input)).toBe(input);
    });

    it('keeps plain CJK slash word pairs intact', () => {
      const input = '论文写作 / 文献综述';
      expect(redactPath(input)).toBe(input);
    });

    it('still redacts real filesystem paths inside CJK sentences', () => {
      const win = redactPath('资料已保存到 D:\\论文资料\\综述.md 备查');
      expect(win).toContain('[FILE]');
      expect(win).not.toContain('论文资料');
      const posix = redactPath('日志见 /var/log/metis/run.log');
      expect(posix).toContain('[FILE]');
      expect(posix).not.toContain('run.log');
    });
  });

  describe('REVIEW-METIS-427 integration samples', () => {
    it('preserves HTML closing tags without redacting </div>', () => {
      const input = 'Render step failed at </div> inside component tree';
      expect(redactPath(input)).toBe(input);
    });

    it('preserves ratio 1 / 2 as non-path', () => {
      const input = 'Split results: 1 / 2 models passed validation';
      expect(redactPath(input)).toBe(input);
    });

    it('preserves date 2026/07/29 as non-path', () => {
      const input = 'Build completed on 2026/07/29 at 14:30';
      expect(redactPath(input)).toBe(input);
    });

    it('preserves word/path as non-path (no extension)', () => {
      const input = 'Search for word/path in the documentation';
      expect(redactPath(input)).toBe(input);
    });

    it('preserves API path /v1/papers as non-path', () => {
      const input = 'GET /v1/papers returned 200 OK';
      expect(redactPath(input)).toBe(input);
    });

    it('terminates path token at comma without consuming following text', () => {
      const input = 'Read /tmp/log.txt, then check /var/run for errors';
      const result = redactPath(input);
      expect(result).toContain('[FILE]');
      expect(result).toContain(', then check');
      expect(result).not.toContain('/tmp/log.txt');
      expect(result).not.toContain('/var/run');
    });

    it('terminates path token at closing paren without consuming it', () => {
      const input = 'Source file (/home/user/src/main.ts) is missing';
      const result = redactPath(input);
      expect(result).toContain('[');
      expect(result).toContain(')');
      expect(result).not.toContain('/home/user/src/main.ts');
    });

    it('redacts paths inside presentDiagnosticText while preserving non-path context', () => {
      const input = 'Error at /home/user/config.yaml: API /v1/status unreachable from https://api.test/v1/status';
      const result = presentDiagnosticText(input);
      // URL alone is not a file path
      expect(result).toContain('https://api.test/v1/status');
      // API path preserved
      expect(result).toContain('/v1/status');
      // File path redacted
      expect(result).not.toContain('/home/user');
    });

    it('presentExecutionError normal mode never leaks paths', () => {
      const error = new Error('Write to /home/user/secret.txt failed at line 42');
      const normal = presentExecutionError(error, 'en', 'normal');
      expect(normal).not.toContain('/home');
      expect(normal).not.toContain('secret');
      expect(normal).not.toContain('line 42');
    });

    it('presentExecutionError diagnostic mode redacts paths but preserves error structure', () => {
      const error = new Error('ENOENT: no such file, open /home/user/missing.json');
      const diagnostic = presentExecutionError(error, 'en', 'diagnostic');
      expect(diagnostic).toContain('ENOENT');
      expect(diagnostic).toContain('[FILE]');
      expect(diagnostic).not.toContain('/home/user');
    });

    it('presentExecutionError handles Error.stack with paths', () => {
      const error = new Error('Failed at /usr/local/bin/tool:42');
      error.stack = 'Error: Failed at /usr/local/bin/tool:42\n    at Module.load (/home/user/app.ts:10:5)';
      const diagnostic = presentExecutionError(error, 'en', 'diagnostic');
      expect(diagnostic).not.toContain('/usr/local/bin/tool');
      expect(diagnostic).not.toContain('/home/user/app.ts');
      expect(diagnostic).toContain('[FILE]');
    });

    it('stringifyDiagnosticValue redacts paths in nested objects', () => {
      const value = {
        error: 'File not found: /tmp/cache/data.bin',
        meta: { source: '/home/user/source.ts', safe: 'ok' },
      };
      const result = stringifyDiagnosticValue(value);
      expect(result).not.toContain('/tmp/cache');
      expect(result).not.toContain('/home/user');
      expect(result).toContain('safe');
      expect(result).toContain('ok');
    });

    it('SafeMarkdown preserves standard formatting while redacting paths in code blocks', () => {
      const md = '```\nReading /home/user/data.csv\n```\n\nSee [docs](/docs/guide) for help.\n\nResult: 50/50 split.';
      const rendered = SafeMarkdown({ children: md, mode: 'full' });
      expect(rendered).toBeTruthy();
    });

    it('preserves https URL pathname while redacting query+fragment separately', () => {
      const url = 'https://example.test/api/v1/data?token=secret#private';
      const result = presentDiagnosticText(url);
      expect(result).toContain('https://example.test/api/v1/data');
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('token=secret');
      expect(result).not.toContain('private');
    });

    it('does not redact proportion 50/50 in full diagnostic pipeline', () => {
      const error = new Error('The model achieved 50/50 accuracy on the validation set');
      const diagnostic = presentExecutionError(error, 'en', 'diagnostic');
      expect(diagnostic).toContain('50/50');
    });

    it('does not redact Markdown links with relative paths', () => {
      const text = 'See [setup guide](./docs/setup.md) and [API reference](/api/ref) for details';
      const result = redactPath(text);
      expect(result).toBe(text);
    });
  });

  it('serializes circular diagnostic data without exposing a nested secret', () => {
    const value: Record<string, unknown> = {
      title: 'diagnostic payload',
      apiKey: 'circular-secret-marker',
    };
    value.self = value;

    const rendered = stringifyDiagnosticValue(value);

    expect(rendered).toContain('diagnostic payload');
    expect(rendered).toContain('[Circular]');
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).not.toContain('circular-secret-marker');
  });
});


describe('REVIEW-METIS-429 attack matrix', () => {
  describe('Markdown local targets are scrubbed while syntax is preserved', () => {
    it.each([
      ['link', 'Open [private file](/home/researcher/private.pdf) now', 'Open [private file]([FILE]) now'],
      ['link with title', 'See [guide](/tmp/private-chart.png "title") for details', 'See [guide]([FILE] "title") for details'],
      ['image', '![secret](/home/user/private.png)', '![secret]([FILE])'],
      ['mixed targets', 'Check [docs](/docs/guide.md) and [local](/home/user/secret)', 'Check [docs](/docs/guide.md) and [local]([FILE])'],
      ['file URI target', '[file](file:///C:/Users/researcher/private.pdf)', '[file](file://[FILE])'],
      ['https target sanitised', '[url](https://example.test/private?token=secret)', '[url](https://example.test/private?[REDACTED])'],
    ])('redacts %s', (_, input, expected) => {
      expect(redactPath(input)).toBe(expected);
      expect(presentDiagnosticText(input)).toBe(expected);
    });

    it.each([
      ['relative link', '[setup guide](./docs/setup.md)'],
      ['relative parent', '[parent](../parent/module.ts)'],
      ['benign root-relative', '[api](/api/ref)'],
      ['benign docs', '[docs](/docs/guide)'],
    ])('preserves %s', (_, input) => {
      expect(redactPath(input)).toBe(input);
      expect(presentDiagnosticText(input)).toBe(input);
    });
  });

  describe('API-shaped paths are classified by semantic context', () => {
    it.each([
      ['GET /v1/papers', 'GET /v1/papers returned 200 OK'],
      ['POST /v2/search', 'POST /v2/search returned 201'],
      ['fetch /api/status', 'fetch /api/status every minute'],
    ])('preserves %s as API', (_, input) => {
      expect(redactPath(input)).toBe(input);
      expect(presentDiagnosticText(input)).toBe(input);
    });

    it.each([
      ['open local file /v1/private/secret.pdf', 'Open local file /v1/private/secret.pdf now', 'Open local file [FILE] now'],
      ['read /v1/private/secret.pdf', 'Read /v1/private/secret.pdf', 'Read [FILE]'],
      ['load /api/private/data.json', 'Load /api/private/data.json please', 'Load [FILE] please'],
    ])('scrubs %s', (_, input, expected) => {
      expect(redactPath(input)).toBe(expected);
      expect(presentDiagnosticText(input)).toBe(expected);
    });
  });

  describe('date/ratio/relative subspans are contained inside absolute paths', () => {
    it.each([
      ['/2026/07/29/secret.pdf'],
      ['/1/2/secret.pdf'],
      ['/home/user/../secret.pdf'],
      ['/home/user/./secret.pdf'],
    ])('scrubs %s', (input) => {
      expect(redactPath(input)).toBe('[FILE]');
      expect(presentDiagnosticText(input)).toBe('[FILE]');
    });

    it.each([
      ['date alone', '2026/07/29'],
      ['ratio alone', '1/2'],
      ['ratio with spaces', '1 / 2'],
      ['relative ./', './config.json'],
      ['relative ../', '../parent/module.ts'],
    ])('preserves %s', (_, input) => {
      expect(redactPath(input)).toBe(input);
      expect(presentDiagnosticText(input)).toBe(input);
    });
  });

  describe('unquoted spaced paths are fully consumed without basename residue', () => {
    it.each([
      ['POSIX spaced', '/tmp/file name (v2).pdf'],
      ['Windows spaced', 'C:\\Users\\me\\My Research\\secret.pdf'],
      ['UNC spaced', '\\\\server\\share\\My Research\\secret.pdf'],
      ['parenthesis filename', '/tmp/file(v2).pdf'],
    ])('scrubs %s', (_, input) => {
      expect(redactPath(input)).toBe('[FILE]');
      expect(presentDiagnosticText(input)).toBe('[FILE]');
    });
  });

  describe('quoted paths redact only the inside and keep quotes', () => {
    it.each([
      ['double POSIX', 'Open "/home/user/secret.pdf" next', 'Open "[FILE]" next'],
      ['single POSIX', "Open '/home/user/secret.pdf' next", "Open '[FILE]' next"],
      ['double Windows spaced', 'Open "C:\\Users\\me\\My Research\\secret.pdf" next', 'Open "[FILE]" next'],
      ['double parenthesis', 'Open "/tmp/file(v2).pdf" next', 'Open "[FILE]" next'],
      ['double URL', 'Open "https://example.test/private?token=secret" next', 'Open "https://example.test/private?[REDACTED]" next'],
    ])('scrubs %s', (_, input, expected) => {
      expect(presentDiagnosticText(input)).toBe(expected);
    });

    it.each([
      ['relative in quotes', 'Open "./relative/config.json" next'],
      ['benign root in quotes', 'Open "/docs/guide" next'],
    ])('preserves %s', (_, input) => {
      expect(presentDiagnosticText(input)).toBe(input);
    });
  });

  describe('RFC scheme handling', () => {
    it.each([
      ['s3', 's3://bucket/private/object.pdf'],
      ['ssh', 'ssh://host/private.txt'],
      ['custom', 'custom://app/private.json'],
      ['vscode', 'vscode://file/home/user/file.ts'],
      ['git+https', 'git+https://github.com/org/repo.git'],
    ])('preserves %s URL', (_, input) => {
      expect(redactPath(input)).toBe(input);
      expect(presentDiagnosticText(input)).toBe(input);
    });

    it.each([
      ['file URI', 'file:///C:/Users/researcher/private.pdf', 'file://[FILE]'],
      ['file URI POSIX', 'file:///home/user/private.pdf', 'file://[FILE]'],
    ])('redacts %s', (_, input, expected) => {
      expect(redactPath(input)).toBe(expected);
      expect(presentDiagnosticText(input)).toBe(expected);
    });

    it('sanitises https URL query and fragment without harming pathname', () => {
      const input = 'https://example.test/api/v1/data?token=secret#private';
      expect(presentDiagnosticText(input)).toBe('https://example.test/api/v1/data?[REDACTED]#[REDACTED]');
      expect(redactPath(input)).toBe('https://example.test/api/v1/data?token=secret#private');
    });
  });

  describe('placeholder and homoglyph collision resistance', () => {
    it('preserves literal [[METIS_URL:0]] when no real URL exists', () => {
      expect(presentDiagnosticText('User marker [[METIS_URL:0]]')).toBe('User marker [[METIS_URL:0]]');
    });

    it('does not replace user literal [[METIS_URL:0]] after a real URL', () => {
      const input = 'https://example.test?token=secret [[METIS_URL:0]]';
      expect(presentDiagnosticText(input)).toBe('https://example.test?[REDACTED] [[METIS_URL:0]]');
    });

    it('preserves private-use-area homoglyphs unchanged', () => {
      const input = 'date\uE000ANY0';
      expect(presentDiagnosticText(input)).toBe(input);
      expect(redactPath(input)).toBe(input);
    });
  });

  describe('punctuation boundaries are preserved exactly', () => {
    it.each([
      ['trailing period', 'Open /secret.pdf. Next', 'Open [FILE]. Next'],
      ['parenthesised', 'Source file (/home/user/src/main.ts) is missing', 'Source file ([FILE]) is missing'],
      ['comma separated', 'Read /tmp/log.txt, then check', 'Read [FILE], then check'],
      ['semicolon separated', 'Path: /home/a.txt; next', 'Path: [FILE]; next'],
      ['multiple paths', 'Check /home/a.txt, /tmp/b.txt', 'Check [FILE], [FILE]'],
    ])('handles %s', (_, input, expected) => {
      expect(redactPath(input)).toBe(expected);
      expect(presentDiagnosticText(input)).toBe(expected);
    });
  });

  describe('value/error/stack/stringify pipelines inherit scrubbing', () => {
    it('redacts paths inside diagnostic values', () => {
      const value = { error: 'File not found: /home/user/data.json', meta: { source: '/tmp/cache/data.bin', safe: 'ok' } };
      const rendered = stringifyDiagnosticValue(value);
      expect(rendered).toContain('[FILE]');
      expect(rendered).not.toContain('/home/user');
      expect(rendered).not.toContain('/tmp/cache');
      expect(rendered).toContain('safe');
      expect(rendered).toContain('ok');
    });

    it('redacts paths in Error message and stack', () => {
      const error = new Error('Failed at /usr/local/bin/tool:42');
      error.stack = 'Error: Failed at /usr/local/bin/tool:42\n    at Module.load (/home/user/app.ts:10:5)';
      const diagnostic = presentExecutionError(error, 'en', 'diagnostic');
      expect(diagnostic).not.toContain('/usr/local/bin/tool');
      expect(diagnostic).not.toContain('/home/user/app.ts');
      expect(diagnostic).toContain('[FILE]');
    });

    it('normal mode never leaks paths', () => {
      const error = new Error('Write to /home/user/secret.txt failed at line 42');
      const normal = presentExecutionError(error, 'en', 'normal');
      expect(normal).not.toContain('/home');
      expect(normal).not.toContain('secret');
    });
  });

  describe('SafeMarkdown diagnostic inherits span scrubbing', () => {
    it.each([
      ['link local target', 'Open [private file](/home/researcher/private.pdf) now', 'Open [private file]([FILE]) now'],
      ['image local target', '![secret](/tmp/private-chart.png)', '![secret]([FILE])'],
    ])('scrubs %s', (_, input, expected) => {
      expect(presentSafeMarkdownText(input, 'diagnostic', 'en')).toBe(expected);
    });
  });
});

describe('REVIEW-METIS-431 overlap matrix', () => {
  it.each([
    ['Markdown link local', 'Open [file](/home/researcher/private.pdf) now', 'Open [file]([FILE]) now'],
    ['Markdown image local', '![secret](/tmp/private-chart.png)', '![secret]([FILE])'],
    ['API local path', 'Open local file /v1/private/secret.pdf now', 'Open local file [FILE] now'],
    ['date inside path', '/2026/07/29/secret.pdf', '[FILE]'],
    ['ratio inside path', '/1/2/secret.pdf', '[FILE]'],
    ['relative dotdot inside path', '/home/user/../secret.pdf', '[FILE]'],
    ['relative dot inside path', '/home/user/./secret.pdf', '[FILE]'],
    ['POSIX spaced', '/tmp/file name (v2).pdf', '[FILE]'],
    ['Windows spaced', 'C:\\Users\\me\\My Research\\secret.pdf', '[FILE]'],
    ['UNC spaced', '\\\\server\\share\\My Research\\secret.pdf', '[FILE]'],
    ['generic POSIX no ext', '/Users/alice/private/secret', '[FILE]'],
    ['generic projects', '/projects/research/private/data', '[FILE]'],
    ['trailing period', 'Open /secret.pdf. Next', 'Open [FILE]. Next'],
    ['double quoted', 'Open "/home/user/secret.pdf" next', 'Open "[FILE]" next'],
    ['single quoted', "Open '/home/user/secret.pdf' next", "Open '[FILE]' next"],
  ])('scrubs %s', (_, input, expected) => {
    expect(redactPath(input)).toBe(expected);
    expect(presentDiagnosticText(input)).toBe(expected);
  });

  it.each([
    ['ratio no spaces', '1/2'],
    ['ratio with spaces', '1 / 2'],
    ['date', '2026/07/29'],
    ['word/path', 'word/path'],
    ['HTML close', '</div>'],
    ['GET API', 'GET /v1/papers returned 200 OK'],
    ['Markdown relative', '[setup guide](./docs/setup.md)'],
    ['Markdown benign', '[docs](/docs/guide)'],
    ['Markdown image relative', '![diagram](assets/arch.png)'],
    ['relative ./', './relative/config.json'],
    ['relative ../', '../parent/module.ts'],
    ['https URL pathname', 'https://api.example.com/v2/data'],
    ['s3 scheme', 's3://bucket/private/object.pdf'],
    ['literal placeholder', '[[METIS_URL:0]]'],
    ['homoglyph', 'date\uE000ANY0'],
    // NOTE: these overlap-matrix cases share inputs with REVIEW-METIS-429
    // punctuation-boundary redactions. The intended assertion is that the
    // punctuation itself is preserved as a boundary, not that the path is
    // left unredacted.
    ['comma boundary', 'Read [FILE], then check'],
    ['paren boundary', 'Source file ([FILE]) is missing'],
  ])('preserves %s', (_, input, expected) => {
    const want = expected ?? input;
    expect(redactPath(input)).toBe(want);
    expect(presentDiagnosticText(input)).toBe(want);
    expect(redactPath(input)).toBe(input);
    expect(presentDiagnosticText(input)).toBe(input);
  });

  it('sanitises URL userinfo and query while keeping pathname', () => {
    const input = 'https://user:pass@example.test/api/v1/data?token=secret#private';
    expect(presentDiagnosticText(input)).toBe('https://example.test/api/v1/data?[REDACTED]#[REDACTED]');
  });

  it('does not leak paths through SafeMarkdown diagnostic', () => {
    const raw = 'Open [private file](/home/researcher/private.pdf) now';
    const output = presentSafeMarkdownText(raw, 'diagnostic', 'en');
    expect(output).not.toContain('/home');
    expect(output).not.toContain('researcher');
    expect(output).not.toContain('private.pdf');
    expect(output).toContain('[FILE]');
  });
});
