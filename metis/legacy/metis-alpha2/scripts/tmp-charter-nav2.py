import io

p = 'src/App.tsx'
s = io.open(p, encoding='utf-8').read()

# 1. 类型
old_type = "type StandalonePage = 'dashboard' | 'goal' | 'timeline' | 'latex' | 'experiments' | 'evals' | 'kanban' | 'outcomes' | 'submissions';"
assert old_type in s, 'type anchor'
s = s.replace(old_type, "type StandalonePage = 'dashboard' | 'goal' | 'timeline' | 'latex' | 'experiments' | 'evals' | 'kanban' | 'outcomes' | 'submissions' | 'charter';")

# 2. lazy
old_lazy = "const SubmissionsPage = lazy(() => import('./pages/SubmissionWorkspacePage'));"
assert old_lazy in s, 'lazy anchor'
s = s.replace(old_lazy, old_lazy + "\nconst ContentCharterPage = lazy(() => import('./pages/ContentCharterPage'));")

# 3. state（挂 personalizationOpen 旁）
old_state = "const [personalizationOpen, setPersonalizationOpen] = useState(false);"
assert old_state in s, 'state anchor'
s = s.replace(old_state, old_state + "\n  const [charterOpen, setCharterOpen] = useState(false);")

# 4. 顶栏按钮：PREFERENCE_NAV_ITEMS 按钮组渲染结束（)})\n          </div>\n        </nav>）之前插入
old_end = "              );\n            })}\n          </div>\n        </nav>"
assert s.count(old_end) == 1, f'nav end anchor count = {s.count(old_end)}'
new_end = """              );
            })}
            <button
              className={`topbar-nav__item ${charterOpen ? 'active' : ''}`}
              onClick={() => { setCharterOpen((open) => !open); setPersonalizationOpen(false); setStandalonePage(null); }}
              aria-current={charterOpen ? 'page' : undefined}
              aria-label="内容规范"
              title="内容规范：写作风格、演示主题、绘图规范与质量阈值，全场景通用"
              data-nav-id="charter"
              data-testid="charter-trigger"
            >内容规范</button>
          </div>
        </nav>"""
s = s.replace(old_end, new_end)

# 5. renderPage 分支
old_render = """  function renderPage() {
    if (personalizationOpen) {
      return <PersonalizationCenter onActivateScenario={activatePersonalizationScenario} />;
    }"""
assert old_render in s, 'render anchor'
new_render = """  function renderPage() {
    if (charterOpen) {
      return (
        <Suspense fallback={<div className="hydration-loading"><div className="hydration-spinner" /><p>Loading…</p></div>}>
          <ContentCharterPage />
        </Suspense>
      );
    }
    if (personalizationOpen) {
      return <PersonalizationCenter onActivateScenario={activatePersonalizationScenario} />;
    }"""
s = s.replace(old_render, new_render)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('app wired')
