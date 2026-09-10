/**
 * HTML renderer — produces a self-contained, print-ready HTML5 document.
 *
 * No external CSS or JavaScript dependencies. The output is a single
 * `.html` file with inline styles, a table of contents, section anchors,
 * footnotes, a bibliography, and an artifact-provenance footer.
 *
 * This renderer is used for the `html` export format and also as the
 * intermediate format when the user chooses the MD/HTML/JSON bundle.
 */

import type {
  RenderInput,
  RenderResult,
} from './RendererTypes.js';
import {
  SCOPE_TITLES,
  collectScopedRecords,
  escapeHtml,
  splitLines,
} from './RendererTypes.js';

const CSS = `
*,*::before,*::after { box-sizing: border-box; }
body {
  font-family: Georgia, "Times New Roman", serif;
  line-height: 1.7;
  max-width: 50rem;
  margin: 2rem auto;
  padding: 0 1.5rem;
  color: #1a1a1a;
}
h1 { font-size: 1.8rem; border-bottom: 2px solid #333; padding-bottom: .3rem; }
h2 { font-size: 1.4rem; margin-top: 2rem; }
h3 { font-size: 1.15rem; margin-top: 1.5rem; }
p { margin: .5rem 0; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #ccc; padding: .4rem .6rem; text-align: left; }
th { background: #f0f0f0; font-weight: 600; }
.toc { background: #f8f8f8; border: 1px solid #ddd; padding: 1rem 1.5rem; margin: 1.5rem 0; }
.toc h2 { margin-top: 0; font-size: 1.2rem; }
.toc ul { list-style: none; padding-left: 0; }
.toc li { margin: .2rem 0; }
.toc a { text-decoration: none; color: #006; }
.toc a:hover { text-decoration: underline; }
.footnotes { font-size: .85rem; border-top: 1px solid #ccc; margin-top: 2rem; padding-top: .5rem; }
.footnote { margin: .3rem 0; }
.bibliography { font-size: .9rem; }
.bibliography li { margin: .3rem 0; }
.provenance {
  margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #ccc;
  font-size: .8rem; color: #666;
}
.provenance dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; }
.provenance dt { font-weight: 600; }
code { background: #f4f4f4; padding: .1rem .3rem; border-radius: 2px; }
@media print { body { max-width: none; margin: 0; } }
`.trim();

interface HtmlBuilder {
  parts: string[];
  push(line: string): void;
  toString(): string;
}

function makeBuilder(): HtmlBuilder {
  const parts: string[] = [];
  return {
    parts,
    push(line: string) { parts.push(line); },
    toString() { return parts.join('\n'); },
  };
}

export function renderHtml(input: RenderInput): RenderResult {
  try {
    const scoped = collectScopedRecords(input);
    const { request } = input;
    const html = makeBuilder();

    // ── Document head ────────────────────────────────────────────
    html.push('<!DOCTYPE html>');
    html.push('<html lang="en">');
    html.push('<head>');
    html.push('  <meta charset="UTF-8">');
    html.push(`  <title>${escapeHtml(request.displayName)}</title>`);
    html.push(`  <style>${CSS}</style>`);
    html.push('</head>');
    html.push('<body>');

    // ── Title ────────────────────────────────────────────────────
    html.push(`<h1>${escapeHtml(request.displayName)}</h1>`);

    // ── Table of Contents ────────────────────────────────────────
    const tocEntries: string[] = [];
    let sectionIndex = 0;
    for (const { scope, records } of scoped) {
      if (records.length === 0) continue;
      const anchor = `section-${sectionIndex}`;
      tocEntries.push(
        `<li><a href="#${anchor}">${escapeHtml(SCOPE_TITLES[scope])}</a></li>`,
      );
      sectionIndex++;
    }

    if (tocEntries.length > 0) {
      html.push('<nav class="toc">');
      html.push('  <h2>Table of Contents</h2>');
      html.push('  <ul>');
      for (const entry of tocEntries) html.push(`  ${entry}`);
      html.push('  </ul>');
      html.push('</nav>');
    }

    // ── Body sections ────────────────────────────────────────────
    sectionIndex = 0;
    const allFootnotes: { num: number; text: string }[] = [];
    const bibliography: { id: string; text: string }[] = [];
    let footnoteCounter = 0;

    for (const { scope, records } of scoped) {
      const anchor = `section-${sectionIndex}`;
      html.push(`<section id="${anchor}">`);
      html.push(`<h2>${escapeHtml(SCOPE_TITLES[scope])}</h2>`);

      for (const record of records) {
        html.push(`<h3>${escapeHtml(record.title)}</h3>`);

        // Content paragraphs
        const lines = splitLines(record.content);
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          html.push(`<p>${escapeHtml(trimmed)}</p>`);
        }

        // Fields as table
        if (record.fields.length > 0) {
          html.push('<table>');
          html.push('<thead><tr><th>Field</th><th>Value</th></tr></thead>');
          html.push('<tbody>');
          for (const field of record.fields) {
            html.push(
              `<tr><td>${escapeHtml(field.key)}</td><td>${escapeHtml(field.value)}</td></tr>`,
            );
          }
          html.push('</tbody></table>');
        }

        // Collect footnotes from fields marked as raw-transcript or model-prompt
        for (const field of record.fields) {
          if (field.sensitivity === 'raw-transcript' || field.sensitivity === 'model-prompt') {
            footnoteCounter++;
            allFootnotes.push({ num: footnoteCounter, text: field.value });
          }
        }

        // Citations scope → bibliography
        if (scope === 'citations') {
          bibliography.push({ id: record.id, text: record.content });
        }
      }

      html.push('</section>');
      sectionIndex++;
    }

    // ── Bibliography ─────────────────────────────────────────────
    if (bibliography.length > 0) {
      html.push('<section class="bibliography">');
      html.push('<h2>Bibliography</h2>');
      html.push('<ol>');
      for (const ref of bibliography) {
        html.push(`<li>${escapeHtml(ref.text)}</li>`);
      }
      html.push('</ol>');
      html.push('</section>');
    }

    // ── Footnotes ────────────────────────────────────────────────
    if (allFootnotes.length > 0) {
      html.push('<section class="footnotes">');
      html.push('<h2>Footnotes</h2>');
      for (const fn of allFootnotes) {
        html.push(`<p class="footnote">[${fn.num}] ${escapeHtml(fn.text)}</p>`);
      }
      html.push('</section>');
    }

    // ── Provenance footer ────────────────────────────────────────
    html.push('<footer class="provenance">');
    html.push('<dl>');
    html.push(`<dt>Export ID</dt><dd><code>${escapeHtml(request.exportId)}</code></dd>`);
    html.push(`<dt>Project ID</dt><dd><code>${escapeHtml(request.projectId)}</code></dd>`);
    html.push(`<dt>Format</dt><dd>html</dd>`);
    html.push(`<dt>Privacy Profile</dt><dd>${escapeHtml(request.privacyProfile)}</dd>`);
    html.push(`<dt>Requested At</dt><dd>${new Date(request.requestedAt).toISOString()}</dd>`);
    html.push(`<dt>Schema Version</dt><dd>2</dd>`);
    html.push(`<dt>Artifact ID</dt><dd><code>${escapeHtml(request.artifactId)}</code></dd>`);
    html.push(`<dt>Artifact Version</dt><dd>${request.artifactVersion}</dd>`);
    html.push(`<dt>Artifact Manifest SHA-256</dt><dd><code>${escapeHtml(request.artifactManifestDigest)}</code></dd>`);
    html.push('</dl>');
    html.push('</footer>');

    html.push('</body>');
    html.push('</html>');

    const content = `${html.toString()}\n`;
    return {
      ok: true,
      bytes: Buffer.from(content, 'utf8'),
      mediaType: 'text/html',
      extension: '.html',
    };
  } catch (err) {
    return {
      ok: false,
      error: `HTML rendering failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
