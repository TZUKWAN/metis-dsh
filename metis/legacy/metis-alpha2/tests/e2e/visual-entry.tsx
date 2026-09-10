/* eslint-disable react-refresh/only-export-components, @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import ProjectShell from '../../src/shell/ProjectShell';
import CommandBar from '../../src/shell/CommandBar';
import '../../src/index.css';

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');
const sp = new URLSearchParams(window.location.search);
const mode = sp.get('mode') || 'shell';
const overlay = sp.get('overlay') || '';

(window as any).__KIMI_VISUAL_READY__ = false;

// ── Standalone ProjectSwitcher with confirm (mode=projectswitcher-direct) ──
function ProjectSwitcherStandalone() {
  const projects = [
    { id:'p1', title:'文献综述：因果识别方法', lifecycle:'completed' as const },
    { id:'p2', title:'DID 政策评估——增值税转型', lifecycle:'running' as const },
    { id:'p3', title:'质性编码——教师访谈研究', lifecycle:'draft' as const },
  ];
  const [, setSwitchedTo] = useState("");
  const [switchedCount, setSwitchedCount] = useState(0);
  const { default: ProjectSwitcher } = require('../../src/shell/ProjectSwitcher');
  return (
    <div style={{width:'100vw',height:'100vh',background:'var(--bg-primary,#fff)',padding:40}}>
      <ProjectSwitcher
        projects={projects}
        activeProjectId="p3"
        confirmSwitch={true}
        onSwitch={(id) => { setSwitchedTo(id); setSwitchedCount(c => c + 1); }}
        onRefresh={() => {}}
        loading={false}
        error={null}
        onClearError={() => {}}
      />
      <div id="switcher-state" data-switched={switchedTo} data-count={switchedCount} style={{display:'none'}} />
    </div>
  );
}

// ── Standalone CommandBar (mode=commandbar-direct) ──
function CommandBarStandalone() {
  const commands = [
    { id:'c1', label:'新建项目', category:'项目', shortcut:'Ctrl+N' },
    { id:'c2', label:'导入文件', category:'项目', shortcut:'Ctrl+I' },
    { id:'c3', label:'搜索资料', category:'资料', shortcut:'Ctrl+P' },
    { id:'c4', label:'导出成果', category:'导出', shortcut:'Ctrl+E' },
    { id:'c5', label:'新建笔记', category:'笔记', shortcut:'Ctrl+Shift+N' },
    { id:'c6', label:'设置面板', category:'系统', shortcut:'Ctrl+,' },
  ];
  return (
    <div style={{width:'100vw',height:'100vh',background:'var(--bg-primary,#fff)',display:'flex',alignItems:'center',justifyContent:'center'}}>
      <CommandBar isOpen={true} onClose={()=>{}} commands={commands} onExecute={()=>{}} />
    </div>
  );
}

// ── ProjectShell with interactive state ──
function ShellWithState() {
  const [commandOpen] = useState(overlay==='commandBar');
  const [, setConfirmCount] = useState(0);
    
  const projectSwitcher = overlay==='projectSwitcher' ? {
    projects: [
      { id:'p1', title:'DID 政策评估——增值税转型', lifecycle:'running' as const },
      { id:'p2', title:'文献综述：因果识别方法', lifecycle:'completed' as const },
      { id:'p3', title:'质性编码——教师访谈研究', lifecycle:'draft' as const },
    ],
    activeProjectId: 'p1',
    onSwitch: (id: string) => { setConfirmCount((c: number) => c + 1); setSwitchedTo(id); },
    onRefresh: () => {},
    loading: false, error: null as string|null,
    onClearError: () => {},
  } : undefined;

  return (
    <ProjectShell
      leftContent={<div style={{padding:16}}><h3>资料树</h3></div>}
      centerContent={<div style={{padding:16}}><h2>对话</h2></div>}
      rightContent={null}
      activeMode="converse" onModeChange={() => {}}
      leftCollapsed={false} rightCollapsed={true}
      onLeftCollapsedChange={() => {}} onRightCollapsedChange={() => {}}
      workspaceHeader={null} runTimeline={null} breadcrumbs={null}
      commandBarOpen={commandOpen}
      commandBar={overlay==='commandBar' ? { isOpen:true, onOpen:()=>{}, onClose:()=>{}, commands:[{id:'c1',label:'搜索',category:'资料'},{id:'c2',label:'新建',category:'项目'}], onExecute:()=>{} } as any : undefined}
      objectTabs={[]} activeObjectTabId={null}
      onObjectTabSelect={() => {}} onObjectTabClose={() => {}} onObjectTabReorder={() => {}}
      selectionActionBar={null} splitPreview={null} versionDiffReviewer={null}
      recycleRestore={null} importCreate={null}
      projectSwitcher={projectSwitcher as any}
      onCommandBarOpen={() => {}} onCommandBarClose={() => {}}
    />
  );
}

try {
  if (mode==='commandbar-direct') {
    createRoot(el).render(<CommandBarStandalone />);
  } else if (mode==='projectswitcher-direct') {
    createRoot(el).render(<ProjectSwitcherStandalone />);
  } else {
    createRoot(el).render(<ShellWithState />);
  }
} catch (err: any) {
  document.getElementById('root')!.textContent = 'ERROR: ' + String(err);
  (document.getElementById('root')!).dataset.errorStack = err.stack || '';
}
(window as any).__KIMI_VISUAL_READY__ = true;
console.log('[visual-entry] KIMI_VISUAL_READY=true');
