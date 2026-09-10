/** MEDIA-304 production Electron visual/a11y validator. */
import { app, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SITE = path.join(ROOT, 'test-results', 'media304-site');
const RESULTS = path.join(ROOT, 'test-results', `media304-${Date.now()}`);
fs.mkdirSync(RESULTS, { recursive: true });

const scriptIndex = process.argv.findIndex((argument) => argument.endsWith('validate-media304.mjs'));
const [label, widthText, heightText, zoomText, direction, a11yMode, overlay] = process.argv.slice(scriptIndex + 1);
const width = Number.parseInt(widthText, 10);
const height = Number.parseInt(heightText, 10);
const zoom = Number.parseFloat(zoomText);
const allowedOverlays = new Set([
  'baseline', 'import', 'conflict', 'referenced', 'selftest_bad', 'selftest_missing_marker',
]);
const profile = path.join(ROOT, 'test-results', `.media304-profile-${label}-${Date.now()}`);
app.setPath('userData', profile);

const errors = [];
const markers = { overlay };

function recordFailure(message) {
  errors.push(message);
}

function writeFailureEvidence(message) {
  fs.writeFileSync(path.join(RESULTS, 'EXIT_1'), message, 'utf8');
  console.error(`EXIT_1:${message}`);
}

function validateArguments() {
  if (scriptIndex < 0) recordFailure('script_argument_missing');
  if (!label) recordFailure('label_missing');
  if (!Number.isInteger(width) || width < 320) recordFailure('invalid_width');
  if (!Number.isInteger(height) || height < 320) recordFailure('invalid_height');
  if (!Number.isFinite(zoom) || zoom < 0.5 || zoom > 3) recordFailure('invalid_zoom');
  if (!['ltr', 'rtl'].includes(direction)) recordFailure('invalid_direction');
  if (!['none', 'fc', 'rm'].includes(a11yMode)) recordFailure('invalid_a11y_mode');
  if (!allowedOverlays.has(overlay)) recordFailure(`unsupported_overlay:${overlay ?? ''}`);
}

async function waitFor(webContents, expression, description, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await webContents.executeJavaScript(expression, true);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`wait_timeout:${description}`);
}

async function click(webContents, selector, description) {
  await waitFor(webContents, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, description);
  const clicked = await webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`, true);
  if (!clicked) throw new Error(`click_failed:${description}`);
}

async function dismissGlobalRecovery(webContents) {
  const dismissed = await webContents.executeJavaScript(`(() => {
    const button = document.querySelector('.research-workspace-alert button');
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`, true);
  if (dismissed) {
    await waitFor(
      webContents,
      `!document.querySelector('.research-workspace-alert')`,
      'global_recovery_dismissed',
    );
  }
  return dismissed;
}

async function scrollPurgePanelIntoView(webContents) {
  const metrics = await webContents.executeJavaScript(`(() => {
    const outer = document.querySelector('.media304-inspector-pane');
    const scroller = document.querySelector('.research-inspector-scroll');
    const panel = document.querySelector('.research-image-purge-panel');
    if (!(outer instanceof HTMLElement) || !(scroller instanceof HTMLElement)
      || !(panel instanceof HTMLElement)) return null;
    outer.scrollTop = 0;
    scroller.scrollTop = scroller.scrollHeight;
    panel.scrollIntoView({ block: 'end', inline: 'nearest' });
    return {
      outerScrollTop: outer.scrollTop,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    };
  })()`, true);
  await webContents.executeJavaScript(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    true,
  );
  return metrics;
}

async function finish(win, exitCode, reason = '') {
  if (exitCode !== 0) writeFailureEvidence(reason || errors.join('|') || 'unknown_failure');
  try { win.webContents.debugger.detach(); } catch { /* not attached */ }
  try { win.destroy(); } catch { /* already destroyed */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exitCode = exitCode;
  app.exit(exitCode);
}

function imageDensity(nativeImage) {
  const bitmap = nativeImage.toBitmap();
  const { width: imageWidth, height: imageHeight } = nativeImage.getSize();
  let nonWhite = 0;
  const pixels = imageWidth * imageHeight;
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const red = bitmap[offset + 2];
    if (red < 248 || green < 248 || blue < 248) nonWhite += 1;
  }
  return { imageWidth, imageHeight, nonWhiteRatio: pixels === 0 ? 0 : nonWhite / pixels };
}

validateArguments();
if (errors.length > 0) {
  writeFailureEvidence(errors.join('|'));
  process.exitCode = 2;
  app.whenReady().then(() => app.exit(2));
} else {
  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      width,
      height,
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: { sandbox: false, contextIsolation: true, backgroundThrottling: false },
    });

    win.webContents.on('console-message', (event) => {
      const level = typeof event === 'object' && event !== null ? event.level : '';
      const message = typeof event === 'object' && event !== null ? event.message : '';
      if ((level === 'error' || level === 3) && !message.includes('Security Warning')) {
        recordFailure(`console:${String(message).slice(0, 180)}`);
      }
    });
    win.webContents.on('did-fail-load', (_event, code, description) => {
      recordFailure(`load:${code}:${description}`);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      recordFailure(`renderer_gone:${details.reason}`);
    });

    try {
      await win.loadFile(path.join(SITE, 'tests', 'e2e', 'media304.html'), {
        query: { overlay, dir: direction },
      });

      await waitFor(win.webContents, `(() => {
        if (window.__MEDIA_VISUAL_ERROR__) throw new Error(window.__MEDIA_VISUAL_ERROR__);
        return window.__MEDIA_VISUAL_READY__ === true;
      })()`, 'fixture_ready', overlay === 'selftest_missing_marker' ? 1_500 : 8_000);

      const bridgeReady = await win.webContents.executeJavaScript(
        `typeof window.metis?.selectFileCapability === 'function'`,
        true,
      );
      if (!bridgeReady) recordFailure('metis_bridge_missing');

      const initialBridgeError = await win.webContents.executeJavaScript(
        `Boolean(document.querySelector('.research-workspace-alert'))`,
        true,
      );
      markers.initialBridgeError = initialBridgeError;
      if (initialBridgeError) recordFailure('initial_bridge_error_visible');

      const title = await win.webContents.executeJavaScript(
        `(document.querySelector('.media304-title')?.textContent || '').trim()`,
        true,
      );
      markers.title = title;
      if (!title.includes(overlay)) recordFailure(`title_mismatch:${title}`);

      if (overlay === 'selftest_bad') recordFailure('intentional_bad_overlay');

      if (overlay === 'import' || overlay === 'conflict') {
        await click(win.webContents, '.research-navigation-item--import-image', 'import_trigger');
        await waitFor(
          win.webContents,
          `Boolean(document.querySelector('.research-workspace-image-import'))`,
          'import_form',
        );
        markers.importForm = true;

        if (overlay === 'conflict') {
          const captionSelector = '.research-workspace-image-import input:not([type="number"])';
          const changed = await win.webContents.executeJavaScript(`(() => {
            const input = document.querySelector(${JSON.stringify(captionSelector)});
            if (!(input instanceof HTMLInputElement)) return false;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, '用于主回归的平行趋势检验图');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()`, true);
          if (!changed) recordFailure('caption_input_failed');
          await click(win.webContents, '.research-workspace-image-import button[type="submit"]', 'import_submit');
          const alertText = await waitFor(
            win.webContents,
            `(() => document.querySelector('.research-workspace-image-import [role="alert"]')?.textContent || '')()`,
            'conflict_alert',
          );
          markers.conflictAlert = alertText;
          if (!String(alertText).includes('标识已存在')) recordFailure(`conflict_copy_mismatch:${alertText}`);
          markers.dismissedGlobalRecovery = await dismissGlobalRecovery(win.webContents);
        }
      }

      if (overlay === 'referenced') {
        await click(win.webContents, '.research-navigation-item--recycle', 'recycle_trigger');
        await waitFor(
          win.webContents,
          `Boolean(document.querySelector('.research-image-purge-panel'))`,
          'purge_panel',
        );

        const purgeAuthority = await win.webContents.executeJavaScript(`(() => {
          const genericItem = [...document.querySelectorAll('.recycle-restore__item')]
            .find((item) => item.textContent?.includes('已删除的安慰剂检验图'));
          return {
            genericRestore: Boolean(genericItem?.querySelector('.recycle-restore__icon-btn--restore')),
            genericDanger: Boolean(genericItem?.querySelector('.recycle-restore__icon-btn--danger')),
            dedicatedButtons: document.querySelectorAll(
              '.research-image-purge-panel .research-image-purge-item .research-button--danger-quiet'
            ).length,
          };
        })()`, true);
        markers.purgeAuthority = purgeAuthority;
        if (!purgeAuthority.genericRestore) recordFailure('generic_image_restore_missing');
        if (purgeAuthority.genericDanger) recordFailure('generic_image_has_permanent_delete');
        if (purgeAuthority.dedicatedButtons !== 1) {
          recordFailure(`dedicated_purge_count:${purgeAuthority.dedicatedButtons}`);
        }

        markers.purgeScrollBefore = await scrollPurgePanelIntoView(win.webContents);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await click(
          win.webContents,
          '.research-image-purge-item .research-button--danger-quiet',
          'purge_open_confirm',
        );
        await click(
          win.webContents,
          '.research-image-purge-confirm .research-button--danger',
          'purge_confirm',
        );
        const referencedText = await waitFor(
          win.webContents,
          `(() => document.querySelector('.research-image-purge-item [role="alert"]')?.textContent || '')()`,
          'referenced_alert',
        );
        markers.referencedAlert = referencedText;
        if (!String(referencedText).includes('仍被引用')) {
          recordFailure(`referenced_copy_mismatch:${referencedText}`);
        }
        markers.dismissedGlobalRecovery = await dismissGlobalRecovery(win.webContents);
        markers.purgeScrollAfter = await scrollPurgePanelIntoView(win.webContents);
      }

      if (zoom !== 1) {
        win.webContents.setZoomFactor(zoom);
        await new Promise((resolve) => setTimeout(resolve, 350));
      }

      if (a11yMode !== 'none') {
        await win.webContents.debugger.attach();
        const features = a11yMode === 'fc'
          ? [{ name: 'forced-colors', value: 'active' }]
          : [{ name: 'prefers-reduced-motion', value: 'reduce' }];
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features });
        await new Promise((resolve) => setTimeout(resolve, 450));
      }

      win.webContents.focus();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' });
      await new Promise((resolve) => setTimeout(resolve, 150));

      await win.webContents.executeJavaScript(
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
        true,
      );
      win.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 250));

      const evidence = await win.webContents.executeJavaScript(`(() => {
        const rect = (selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) return null;
          const value = element.getBoundingClientRect();
          return { left: value.left, top: value.top, right: value.right, bottom: value.bottom,
            width: value.width, height: value.height };
        };
        const active = document.activeElement;
        const style = active instanceof HTMLElement ? getComputedStyle(active) : null;
        const html = document.body.innerHTML;
        const text = document.body.textContent || '';
        const suspiciousTerms = [
          'identifier', 'sourceVersionHash', 'sha256', 'ownerKey', 'owner_binding',
          'filePath', 'resolvedPath', 'managedPath', 'base64Data', 'data:image/',
        ].filter((term) => html.toLowerCase().includes(term.toLowerCase()));
        const pathMatch = text.match(/(?:[A-Z]:[\\\\/][^\\s<>"|?*]+|\\\\\\\\[^\\s<>"|?*]+)/i)?.[0] || '';
        const digestMatch = text.match(/\\b[a-f0-9]{64}\\b/i)?.[0] || '';
        const mediaButton = document.querySelector('.research-navigation-item--import-image');
        const mediaStyle = mediaButton instanceof HTMLElement ? getComputedStyle(mediaButton) : null;
        return {
          viewport: { width: innerWidth, height: innerHeight, bodyScrollWidth: document.body.scrollWidth,
            bodyScrollHeight: document.body.scrollHeight,
            sidebarClientWidth: document.querySelector('.media304-sidebar-pane')?.clientWidth || 0,
            sidebarScrollWidth: document.querySelector('.media304-sidebar-pane')?.scrollWidth || 0,
            inspectorClientWidth: document.querySelector('.media304-inspector-pane')?.clientWidth || 0,
            inspectorScrollWidth: document.querySelector('.media304-inspector-pane')?.scrollWidth || 0 },
          rects: {
            root: rect('.media304-root'), sidebar: rect('.media304-sidebar-pane'),
            inspector: rect('.media304-inspector-pane'),
            importForm: rect('.research-workspace-image-import'),
            purgePanel: rect('.research-image-purge-panel'),
            alert: rect('.research-workspace-image-import [role="alert"], .research-image-purge-item [role="alert"]'),
          },
          focus: active instanceof HTMLElement ? {
            tag: active.tagName, name: active.getAttribute('aria-label') || active.textContent?.trim().slice(0, 60) || '',
            outlineWidth: style?.outlineWidth || '', outlineStyle: style?.outlineStyle || '',
            outlineColor: style?.outlineColor || '', outlineOffset: style?.outlineOffset || '',
          } : null,
          mediaTransitionDuration: mediaStyle?.transitionDuration || '',
          matchMedia: {
            forcedColors: matchMedia('(forced-colors: active)').matches,
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          },
          direction: document.documentElement.dir,
          leaks: { suspiciousTerms, pathMatch, digestMatch },
        };
      })()`, true);

      const actualZoom = win.webContents.getZoomFactor();
      evidence.actualZoom = actualZoom;
      markers.evidence = evidence;

      const withinViewport = (value) => value
        && value.left >= -1 && value.top >= -1
        && value.right <= evidence.viewport.width + 1
        && value.bottom <= evidence.viewport.height + 1;
      for (const key of ['root', 'sidebar', 'inspector']) {
        if (!withinViewport(evidence.rects[key])) recordFailure(`bounds:${key}`);
      }
      const overlayRect = overlay === 'referenced'
        ? evidence.rects.purgePanel
        : (overlay === 'import' || overlay === 'conflict' ? evidence.rects.importForm : null);
      if (overlayRect && !withinViewport(overlayRect)) recordFailure(`bounds:${overlay}`);
      if ((overlay === 'conflict' || overlay === 'referenced') && !withinViewport(evidence.rects.alert)) {
        recordFailure(`bounds:${overlay}_alert`);
      }

      if (width <= 500) {
        if (evidence.rects.sidebar?.height < 180 || evidence.rects.inspector?.height < 180) {
          recordFailure('narrow_panes_not_visible');
        }
        if ((evidence.rects.inspector?.top ?? 0) <= (evidence.rects.sidebar?.top ?? 0)) {
          recordFailure('narrow_not_stacked');
        }
      }
      if (evidence.viewport.bodyScrollWidth > evidence.viewport.width + 1) {
        recordFailure(`horizontal_overflow:${evidence.viewport.bodyScrollWidth}>${evidence.viewport.width}`);
      }
      if (evidence.viewport.sidebarScrollWidth > evidence.viewport.sidebarClientWidth + 1) {
        recordFailure(`sidebar_horizontal_overflow:${evidence.viewport.sidebarScrollWidth}>${evidence.viewport.sidebarClientWidth}`);
      }
      if (evidence.viewport.inspectorScrollWidth > evidence.viewport.inspectorClientWidth + 1) {
        recordFailure(`inspector_horizontal_overflow:${evidence.viewport.inspectorScrollWidth}>${evidence.viewport.inspectorClientWidth}`);
      }

      const focusWidth = Number.parseFloat(evidence.focus?.outlineWidth || '0');
      if (!evidence.focus || evidence.focus.outlineStyle === 'none' || focusWidth < 0.5) {
        recordFailure('focus_outline_missing');
      }
      if (Math.abs(actualZoom - zoom) > 0.01) recordFailure(`zoom_mismatch:${actualZoom}`);
      if (zoom >= 2 && evidence.viewport.width >= width * 0.75) recordFailure('zoom_layout_not_scaled');
      if (direction !== evidence.direction) recordFailure(`direction_mismatch:${evidence.direction}`);
      if (a11yMode === 'fc' && !evidence.matchMedia.forcedColors) recordFailure('forced_colors_not_active');
      if (a11yMode === 'rm' && !evidence.matchMedia.reducedMotion) recordFailure('reduced_motion_not_active');
      if (a11yMode === 'rm' && evidence.mediaTransitionDuration !== '0s') {
        recordFailure(`reduced_motion_transition:${evidence.mediaTransitionDuration}`);
      }
      if (a11yMode === 'none' && (evidence.matchMedia.forcedColors || evidence.matchMedia.reducedMotion)) {
        recordFailure('unexpected_a11y_media');
      }
      if (evidence.leaks.suspiciousTerms.length > 0) {
        recordFailure(`dom_terms:${evidence.leaks.suspiciousTerms.join(',')}`);
      }
      if (evidence.leaks.pathMatch) recordFailure(`dom_path:${evidence.leaks.pathMatch}`);
      if (evidence.leaks.digestMatch) recordFailure('dom_digest');

      const capture = await win.webContents.capturePage();
      const png = capture.toPNG();
      const density = imageDensity(capture);
      const sha256 = createHash('sha256').update(png).digest('hex');
      const output = path.join(RESULTS, `media304-${label}.png`);
      fs.writeFileSync(output, png);

      if (density.imageWidth < width - 24 || density.imageHeight < height - 80) {
        recordFailure(`capture_size:${density.imageWidth}x${density.imageHeight}`);
      }
      if (density.nonWhiteRatio < 0.02) {
        recordFailure(`blank_capture:${density.nonWhiteRatio.toFixed(6)}`);
      }

      const result = {
        label, overlay, output, bytes: png.length, sha256,
        image: density, markers, errors,
      };
      fs.writeFileSync(path.join(RESULTS, 'evidence.json'), JSON.stringify(result, null, 2), 'utf8');
      console.log(`SHOT:${output}`);
      console.log(`IMAGE:${density.imageWidth}x${density.imageHeight} ${png.length}B nonWhite=${(density.nonWhiteRatio * 100).toFixed(2)}%`);
      console.log(`SHA256:${sha256}`);
      console.log(`EVIDENCE:${JSON.stringify(evidence)}`);
      console.log(`MARKERS:${JSON.stringify(markers)}`);

      if (errors.length > 0) {
        console.error(`ERRORS:${errors.join('|')}`);
        await finish(win, 1, errors.join('|'));
      } else {
        await finish(win, 0);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordFailure(`fatal:${message}`);
      console.error(`FATAL:${message}`);
      await finish(win, 1, errors.join('|'));
    }
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    writeFailureEvidence(`app_ready:${message}`);
    process.exitCode = 1;
    app.exit(1);
  });
}
