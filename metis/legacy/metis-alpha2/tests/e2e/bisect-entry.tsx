/* eslint-disable react-refresh/only-export-components, @typescript-eslint/no-explicit-any */
import { createRoot } from 'react-dom/client';
import { useId, useState } from 'react';
import ProjectShell from '../../src/shell/ProjectShell';
import '../../src/index.css';

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');
const stage = parseInt(new URLSearchParams(window.location.search).get('stage') || '0');

(window as any).__KIMI_VISUAL_READY__ = false;

function PureDiv() { return <div><h1>Stage 0: pure div</h1></div>; }
function UseIdTest() { const id = useId(); return <div><h1>useId={id}</h1></div>; }
function MiniTabs() { const id = useId(); const [a,s]=useState('a'); return <div role="tablist">{['a','b'].map(k=><button key={k} role="tab" aria-selected={a===k} onClick={()=>s(k)}>Tab {k} ({id})</button>)}</div>; }

function App() {
  if (stage === 1) return <UseIdTest />;
  if (stage === 2) return <MiniTabs />;
  if (stage >= 3) {
    return ProjectShell({
      leftContent: (<div style={{padding:16}}><h3>资料树</h3><p>Source / Evidence / Notes</p></div>) as any,
      centerContent: stage === 4
        ? (<div style={{padding:16}}><h2>对话</h2><p>Chat - 长中文内容测试：社会科学因果识别与政策评估研究方法的文本渲染验证。</p></div>) as any
        : (<div style={{padding:16}}><h2>对话</h2><p>Chat placeholder</p></div>) as any,
      rightContent: null,
      activeMode: 'converse', onModeChange: () => {},
      leftCollapsed: false, rightCollapsed: true,
      onLeftCollapsedChange: () => {}, onRightCollapsedChange: () => {},
      workspaceHeader: stage === 4 ? (<div style={{padding:'8px 12px',background:'var(--bg-secondary,#f8f9fa)',borderBottom:'1px solid var(--border-color,#e2e8f0)'}}><span style={{fontWeight:600}}>工作台 · 长项目名——社会科学因果识别与政策评估研究</span></div>) as any : null,
      runTimeline: null, breadcrumbs: null,
      commandBarOpen: false,
      objectTabs: stage === 4 ? [{id:'tab1',label:'对话',icon:'💬'},{id:'tab2',label:'长标签——文献综述与理论框架构建',icon:'📖'}] : [],
      selectionActionBar: null, splitPreview: null, versionDiffReviewer: null,
      recycleRestore: null, importCreate: null, projectSwitcher: null,
      activeObjectTabId: 'tab1',
      onObjectTabSelect: () => {}, onObjectTabClose: () => {}, onObjectTabReorder: () => {},
      onCommandBarOpen: () => {}, onCommandBarClose: () => {},
    });
  }
  return <PureDiv />;
}

try { createRoot(el).render((<App />) as any); } catch (err: any) {
  document.getElementById('root')!.textContent = `STAGE ${stage} CRASH: ${err.message}\n${err.stack}`;
}
(window as any).__KIMI_VISUAL_READY__ = true;
