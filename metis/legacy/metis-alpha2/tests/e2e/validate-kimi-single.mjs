/**
 * Visual capture v4: overlays, keyboard, focus-visible, bounding-rect validation.
 */
import { app, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SITE = path.join(ROOT, 'test-results', 'kimi-visual-site');
const RESULTS = path.join(ROOT, 'test-results', `kimi-visual-${Date.now()}`);
fs.mkdirSync(RESULTS, { recursive: true });

const scriptIdx = process.argv.findIndex(a => a.endsWith('validate-kimi-single.mjs'));
const [label, w, h, z, dir, a11yMode, overlay] = process.argv.slice(scriptIdx + 1);
const width = parseInt(w), height = parseInt(h), zoomFactor = parseFloat(z);
const runId = `${label}-${Date.now()}`;
app.setPath('userData', path.join(ROOT, 'test-results', `.ep-${runId}`));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width, height, show: false, backgroundThrottling: false, webPreferences: { sandbox: false, contextIsolation: true } });
  try {
    // Build URL with overlay + mode + dir
    const qs = [`mode=${overlay==='commandBar'?'commandbar-direct':overlay==='projectSwitcher'?'projectswitcher-direct':'shell'}`];
    if (overlay) qs.push(`overlay=${overlay}`);
    if (dir==='rtl') qs.push('dir=rtl');
    const { pathname } = await import('node:url').then(m => m.pathToFileURL(path.join(SITE, 'tests', 'e2e', 'index.html')));
    await win.loadURL(`file://${pathname}?${qs.join('&')}`);

    await new Promise((resolve, reject) => {
      const t = Date.now();
      const iv = setInterval(async () => {
        try { if (await win.webContents.executeJavaScript('window.__KIMI_VISUAL_READY__')) { clearInterval(iv); resolve(); } } catch {}
        if (Date.now()-t > 15000) { clearInterval(iv); reject(new Error('timeout')); }
      }, 200);
    });

    const stack = await win.webContents.executeJavaScript('document.getElementById("root")?.dataset?.errorStack||""');
    if (stack) { console.log(`RENDER_ERROR: ${stack.slice(0,500)}`); }

    if (zoomFactor !== 1) { win.webContents.setZoomFactor(zoomFactor); await new Promise(r=>setTimeout(r,500)); }
    if (dir==='rtl') { await win.webContents.executeJavaScript(`document.documentElement.dir='rtl'`); await new Promise(r=>setTimeout(r,500)); }

    if (a11yMode) {
      const needsFc=a11yMode.includes('fc'), needsRm=a11yMode.includes('rm');
      if (needsFc) await win.webContents.insertCSS(`@media (forced-colors:active){*,*::after,*::before{forced-color-adjust:none!important}}`);
      if (needsRm) await win.webContents.insertCSS(`@media (prefers-reduced-motion:reduce){*,*::after,*::before{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important}}`);
      try { await win.webContents.debugger.attach(); const feats=[]; if(needsFc)feats.push({name:'forced-colors',value:'active'}); if(needsRm)feats.push({name:'prefers-reduced-motion',value:'reduce'}); if(feats.length)await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:feats}); await new Promise(r=>setTimeout(r,800)); } catch(e){ console.log(`CDP:${e.message}`); }
    }

    // --- Overlay interaction: real DOM clicks/keyboard ---
    if (overlay==='commandBar') {
      // Click the "打开命令面板" button (direct DOM click, bypasses key event issues)
      const clicked = await win.webContents.executeJavaScript(`(function(){
        const btns=document.querySelectorAll('button');
        for(const b of btns){ if(b.textContent?.includes('打开命令面板')||b.getAttribute('aria-label')?.includes('命令面板')){ b.click(); return true; }}
        return false;
      })()`);
      console.log(`CMDBAR_CLICK: ${clicked}`);
      await new Promise(r=>setTimeout(r,600));
    }
    if (overlay==='projectSwitcher') {
      const opened = await win.webContents.executeJavaScript(`(function(){
        const btn=document.querySelector('[aria-haspopup="listbox"]');
        if(btn){ btn.click(); return true; } return false;
      })()`);
      console.log(`SW_OPEN: ${opened}`);
      await new Promise(r=>setTimeout(r,600));

      const clicked = await win.webContents.executeJavaScript(`(function(){
        const opts=document.querySelectorAll('[role="option"]');
        for(const o of opts){ if(o.getAttribute('aria-selected')!=='true'){ o.click(); return o.textContent?.slice(0,40); }}
        return null;
      })()`);
      console.log(`SW_CLICK: ${clicked}`);
      await new Promise(r=>setTimeout(r,1000));

      // Diagnostic: check button computed styles + visibility
      const diag = await win.webContents.executeJavaScript(`(function(){
        const d=document.querySelector('[role="alertdialog"]');
        if(!d)return {found:false};
        const btns=d.querySelectorAll('button');
        const info=Array.from(btns).map(b=>{
          const cs=getComputedStyle(b);
          const r=b.getBoundingClientRect();
          const cx=r.left+r.width/2, cy=r.top+r.height/2;
          const atPoint=document.elementFromPoint(cx,cy);
          return {
            text:b.textContent?.trim(),
            display:cs.display, visibility:cs.visibility, opacity:cs.opacity,
            rect:{left:Math.round(r.left),top:Math.round(r.top),right:Math.round(r.right),bottom:Math.round(r.bottom),w:Math.round(r.width),h:Math.round(r.height)},
            zIndex:cs.zIndex,
            atPoint:atPoint?atPoint.tagName+'.'+atPoint.className?.slice(0,30):'null',
          };
        });
        return {found:true,text:d.textContent?.slice(0,200),visible:!!d.offsetParent,info};
      })()`);
      console.log(`SW_DIAG: ${JSON.stringify(diag)}`);

      // Force paint + invalidate
      await win.webContents.executeJavaScript(`(function(){ return new Promise(r=>{ requestAnimationFrame(()=>{ requestAnimationFrame(()=>{ setTimeout(r,500); }); }); }); })()`);
      try { win.webContents.invalidate(); } catch(e) {}
      await new Promise(r=>setTimeout(r,300));

      // Full + crop capture
      let cropOk = false;
      if (diag?.found) {
        const r = diag.info[0]?.rect;
        if (r && r.w > 0 && r.h > 0) {
          try {
            const crop = await win.webContents.capturePage({x:r.left-4, y:r.top-4, width:r.w+150, height:r.h+44});
            const cropPath = path.join(RESULTS, `kimi-${label}-crop.png`);
            fs.writeFileSync(cropPath, crop.toPNG());
            console.log(`CROP: ${cropPath} ${crop.toPNG().length}B`);
            cropOk = true;
          } catch(e) { console.log(`CROP_ERR: ${e.message}`); }
        }
      }
      const png = await win.webContents.capturePage();
      const pngBytes = png.toPNG();
      const sha = createHash('sha256').update(pngBytes).digest('hex').slice(0,16);
      const out = path.join(RESULTS, `kimi-${label}.png`);
      fs.writeFileSync(out, pngBytes);
      const st = await win.webContents.executeJavaScript(`(function(){
        const el=document.getElementById('switcher-state');
        return el?{switched:el.dataset.switched,count:el.dataset.count}:null;
      })()`);
      console.log(`SHOT: ${out} ${pngBytes.length}B sha=${sha} crop=${cropOk} state=${JSON.stringify(st)}`);
      try { win.webContents.debugger.detach(); } catch {}
      win.destroy();
      app.exit();
      return;
    }
    if (overlay==='focusTab') {
      // Tab through to a real interactive element
      for(let i=0;i<3;i++){ await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))`); await new Promise(r=>setTimeout(r,200)); }
    }

    // --- Focus-visible: Tab through interactive elements ---
    const focusInfo = await win.webContents.executeJavaScript(`(function(){
      const results=[];
      document.querySelectorAll('button:not([disabled]),[role="tab"],[role="combobox"],[role="searchbox"],input,select,textarea,[tabindex]:not([tabindex="-1"])').forEach(el=>{
        el.focus();
        const cs=getComputedStyle(el);
        results.push({
          role:el.getAttribute('role')||el.tagName.toLowerCase(),
          name:el.getAttribute('aria-label')||el.textContent?.slice(0,40)||'',
          outline:cs.outlineStyle+' '+cs.outlineWidth+' '+cs.outlineColor,
        });
      });
      return {count:results.length,first5:results.slice(0,5)};
    })()`);
    console.log(`FOCUS: ${focusInfo.count} interactive, first5=${JSON.stringify(focusInfo.first5)}`);

    // --- Bounding rect check for overlays ---
    const bounds = await win.webContents.executeJavaScript(`(function(){
      const overlays=document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="listbox"]');
      const results=[];
      overlays.forEach(el=>{
        const r=el.getBoundingClientRect();
        const role=el.getAttribute('role')||'';
        results.push({role,left:r.left,top:r.top,right:r.right,bottom:r.bottom,iw:window.innerWidth,ih:window.innerHeight,ok:r.left>=-1&&r.top>=-1&&r.right<=window.innerWidth+1&&r.bottom<=window.innerHeight+1});
      });
      return results;
    })()`);
    bounds.forEach(b=>console.log(`BOUNDS: ${b.role} left=${b.left} top=${b.top} right=${b.right} bottom=${b.bottom} vs ${b.iw}x${b.ih} OK=${b.ok}`));
    const anyOffScreen = bounds.some(b=>!b.ok);
    if (anyOffScreen) console.log('BOUNDS_WARN: overlay off-screen detected');

    // --- Tabs scroll check ---
    const scrollInfo = await win.webContents.executeJavaScript(`(function(){
      const tl=document.querySelector('[role="tablist"]');
      if(!tl)return null;
      return {scrollWidth:tl.scrollWidth,clientWidth:tl.clientWidth,overflow:tl.scrollWidth>tl.clientWidth};
    })()`);
    if (scrollInfo) console.log(`TABS: scrollW=${scrollInfo.scrollWidth} clientW=${scrollInfo.clientWidth} overflow=${scrollInfo.overflow}`);

    // Screenshot
    const png = await win.webContents.capturePage();
    const pngBytes = png.toPNG();
    const sha = createHash('sha256').update(pngBytes).digest('hex').slice(0,16);
    const out = path.join(RESULTS, `kimi-${label}.png`);
    fs.writeFileSync(out, pngBytes);
    const layout = await win.webContents.executeJavaScript(`JSON.stringify({iw:window.innerWidth,ih:window.innerHeight,dpr:window.devicePixelRatio,zoom:${zoomFactor}})`);
    console.log(`SHOT: ${out} ${pngBytes.length}B sha=${sha} layout=${layout}`);

    try { win.webContents.debugger.detach(); } catch {}
  } catch(e) { console.log(`ERROR: ${e.message}`); process.exitCode=1; }
  finally { win.destroy(); app.exit(); }
});
