/** Strict, dependency-free validation for static SVG assets used by Outcomes. */

export const MAX_OUTCOME_SVG_BYTES = 5 * 1024 * 1024;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const MAX_ELEMENTS = 10_000;
const MAX_NESTING = 100;

const SAFE_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker',
  'text', 'tspan', 'textPath', 'title', 'desc',
]);

const SAFE_ATTRIBUTES = new Set([
  'id', 'class', 'style', 'transform', 'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity',
  'display', 'visibility', 'clip-path', 'clip-rule', 'mask', 'marker-start',
  'marker-mid', 'marker-end', 'vector-effect', 'paint-order', 'color',
  'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity',
  'offset', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'patternUnits', 'patternContentUnits', 'patternTransform',
  'viewBox', 'preserveAspectRatio', 'version', 'width', 'height',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'dx', 'dy', 'd', 'points', 'href', 'xlink:href',
  'font-family', 'font-size', 'font-style', 'font-weight', 'text-anchor',
  'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'textLength',
  'lengthAdjust', 'startOffset', 'rotate', 'text-decoration',
  'clipPathUnits', 'maskUnits', 'maskContentUnits', 'markerWidth', 'markerHeight',
  'markerUnits', 'refX', 'refY', 'orient', 'preserveAlpha', 'in', 'in2', 'result',
]);

const SAFE_STYLE_PROPERTIES = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray',
  'stroke-dashoffset', 'opacity', 'display', 'visibility', 'clip-path', 'clip-rule',
  'mask', 'marker-start', 'marker-mid', 'marker-end', 'vector-effect', 'paint-order',
  'color', 'stop-color', 'stop-opacity', 'font-family', 'font-size', 'font-style',
  'font-weight', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'letter-spacing', 'text-decoration',
]);

const XML_ENTITY_MARKER = /&/u;
const URL_FUNCTION = /url\s*\(([^)]*)\)/giu;
const SAFE_FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/u;
const SAFE_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:px|pt|pc|mm|cm|in|%)?$/u;
const SAFE_VIEWBOX = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:[ \t]+|,)[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:[ \t]+|,)[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:[ \t]+|,)[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

function decodeBuiltinEntities(value: string): string | undefined {
  return XML_ENTITY_MARKER.test(value) ? undefined : value;
}

function hasOnlySafeUrlFunctions(value: string): boolean {
  for (const match of value.matchAll(URL_FUNCTION)) {
    const target = match[1]?.trim() ?? '';
    if (!SAFE_FRAGMENT.test(target)) return false;
  }
  return true;
}

function hasDangerousReference(value: string): boolean {
  return /(?:javascript|vbscript|data|file|https?|ftp):|\/\//iu.test(value)
    || /(?:expression\s*\(|@import|behavior\s*:|-moz-binding|<|>)/iu.test(value)
    || !hasOnlySafeUrlFunctions(value);
}

function validStyle(value: string): boolean {
  if (!value.trim()) return true;
  if (hasDangerousReference(value)) return false;
  for (const declaration of value.split(';')) {
    const trimmed = declaration.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) return false;
    const property = trimmed.slice(0, separator).trim().toLowerCase();
    const propertyValue = trimmed.slice(separator + 1).trim();
    if (!SAFE_STYLE_PROPERTIES.has(property) || !propertyValue || hasDangerousReference(propertyValue)) return false;
  }
  return true;
}

function validDimension(value: string): boolean {
  if (!SAFE_NUMBER.test(value.trim())) return false;
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function validViewBox(value: string): boolean {
  if (!SAFE_VIEWBOX.test(value.trim())) return false;
  const numbers = value.trim().split(/[\s,]+/u).map(Number);
  return numbers.length === 4 && numbers.every(Number.isFinite) && numbers[2]! > 0 && numbers[3]! > 0;
}

function tagEnd(source: string, start: number): number {
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

type AttributeMap = Map<string, string>;

function parseAttributes(source: string): AttributeMap | undefined {
  const attributes = new Map<string, string>();
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    if (cursor >= source.length) break;
    const name = source.slice(cursor).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/u)?.[1];
    if (!name) return undefined;
    cursor += name.length;
    if (attributes.has(name)) return undefined;
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== '=') return undefined;
    cursor += 1;
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") return undefined;
    cursor += 1;
    const valueStart = cursor;
    while (cursor < source.length && source[cursor] !== quote) cursor += 1;
    if (cursor >= source.length) return undefined;
    const decoded = decodeBuiltinEntities(source.slice(valueStart, cursor));
    if (decoded === undefined) return undefined;
    attributes.set(name, decoded);
    cursor += 1;
  }
  return attributes;
}

function validAttributes(element: string, attributes: AttributeMap, root: boolean, xlinkDeclared: boolean): boolean {
  for (const [name, value] of attributes) {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith('on') || lowerName.includes('script')) return false;
    if (name === 'xmlns') {
      if (!root || value !== SVG_NAMESPACE) return false;
      continue;
    }
    if (name === 'xmlns:xlink') {
      if (!root || value !== XLINK_NAMESPACE) return false;
      continue;
    }
    if (name === 'xml:space') {
      if (value !== 'default' && value !== 'preserve') return false;
      continue;
    }
    if (name.includes(':') && name !== 'xlink:href') return false;
    if (!SAFE_ATTRIBUTES.has(name)) return false;
    if (name === 'style' && !validStyle(value)) return false;
    if (name === 'xlink:href' && !xlinkDeclared) return false;
    if ((name === 'href' || name === 'xlink:href') && value !== '' && !SAFE_FRAGMENT.test(value)) return false;
    if (hasDangerousReference(value)) return false;
    if (name === 'viewBox' && !validViewBox(value)) return false;
    if ((element === 'svg' && (name === 'width' || name === 'height')) && !validDimension(value)) return false;
  }
  return true;
}

function hasForbiddenControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f) return true;
  }
  return false;
}

function validXmlDeclaration(value: string): boolean {
  if (!/^<\?xml\b[\s\S]*\?>$/iu.test(value)) return false;
  const encoding = value.match(/\bencoding\s*=\s*(['"])(.*?)\1/iu)?.[2];
  return encoding === undefined || encoding.toLowerCase() === 'utf-8';
}

/** Returns true only for a bounded, static, self-contained SVG XML document. */
export function isSafeSvgBuffer(bytes: Buffer): boolean {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_OUTCOME_SVG_BYTES) return false;
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  if (!source || hasForbiddenControlCharacter(source)) return false;

  const stack: string[] = [];
  let rootSeen = false;
  let rootClosed = false;
  let xmlDeclarationSeen = false;
  let xlinkDeclared = false;
  let elements = 0;
  let cursor = 0;

  while (cursor < source.length) {
    const next = source.indexOf('<', cursor);
    if (next < 0) {
      const text = source.slice(cursor);
      if (!rootClosed && !stack.length && text.trim()) return false;
      if (rootClosed && text.trim()) return false;
      if (XML_ENTITY_MARKER.test(text)) return false;
      break;
    }
    const text = source.slice(cursor, next);
    if (!stack.length && text.trim()) return false;
    if (XML_ENTITY_MARKER.test(text)) return false;

    if (source.startsWith('<?', next)) {
      const end = source.indexOf('?>', next + 2);
      if (end < 0 || next !== 0 || xmlDeclarationSeen || !validXmlDeclaration(source.slice(next, end + 2))) return false;
      xmlDeclarationSeen = true;
      cursor = end + 2;
      continue;
    }
    if (source.startsWith('<!--', next) || source.startsWith('<!', next) || source.startsWith('<![CDATA[', next)) return false;

    const end = tagEnd(source, next + 1);
    if (end < 0) return false;
    const raw = source.slice(next, end + 1);
    if (raw.startsWith('</')) {
      const closing = raw.match(/^<\/([A-Za-z_][A-Za-z0-9_.-]*)\s*>$/u);
      if (!closing || !stack.length || stack[stack.length - 1] !== closing[1]) return false;
      stack.pop();
      if (rootSeen && !stack.length) rootClosed = true;
      cursor = end + 1;
      continue;
    }

    const opening = raw.match(/^<([A-Za-z_][A-Za-z0-9_.-]*)([\s\S]*?)>$/u);
    if (!opening) return false;
    const element = opening[1]!;
    if (!SAFE_ELEMENTS.has(element) || elements >= MAX_ELEMENTS || stack.length >= MAX_NESTING) return false;
    if (rootClosed || (element !== 'svg' && !rootSeen) || (element === 'svg' && !rootSeen && stack.length)) return false;
    const body = opening[2] ?? '';
    const selfClosing = /\/\s*$/u.test(body);
    const attributeSource = selfClosing ? body.replace(/\/\s*$/u, '') : body;
    const attributes = parseAttributes(attributeSource);
    if (!attributes || !validAttributes(element, attributes, !rootSeen, xlinkDeclared || attributes.has('xmlns:xlink'))) return false;
    if (attributes.has('xmlns:xlink')) xlinkDeclared = true;
    if (!rootSeen) {
      if (element !== 'svg' || !attributes.has('xmlns')) return false;
      const hasViewBox = attributes.has('viewBox');
      const hasDimensions = attributes.has('width') && attributes.has('height');
      if (!hasViewBox && !hasDimensions) return false;
      rootSeen = true;
    }
    elements += 1;
    if (!selfClosing) stack.push(element);
    if (selfClosing && !stack.length && rootSeen) rootClosed = true;
    cursor = end + 1;
  }

  return rootSeen && rootClosed && stack.length === 0;
}

/**
 * Explicit standalone-export boundary for Outcomes SVG.
 *
 * The returned artifact is a defensive byte copy, carries its on-disk MIME
 * contract, and is guaranteed to be a bounded static SVG with no external
 * resources. This is intentionally a binary export contract, not an SVG
 * vector-tree editor or a raster animation format adapter.
 */
export type StandaloneSvgExport = Readonly<{
  bytes: Buffer;
  mediaType: 'image/svg+xml';
  extension: 'svg';
}>;

export function exportStandaloneSvg(bytes: Buffer): StandaloneSvgExport {
  if (!isSafeSvgBuffer(bytes)) throw new Error('svg_not_safe_standalone');
  return { bytes: Buffer.from(bytes), mediaType: 'image/svg+xml', extension: 'svg' };
}

/** Re-validate and copy an exported artifact before it crosses a persistence boundary. */
export function roundTripStandaloneSvg(exported: StandaloneSvgExport): Buffer {
  if (!exported || exported.mediaType !== 'image/svg+xml' || exported.extension !== 'svg' || !isSafeSvgBuffer(exported.bytes)) {
    throw new Error('svg_not_safe_roundtrip');
  }
  return Buffer.from(exported.bytes);
}
