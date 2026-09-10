import io

# 1. SettingsPanel 移除挂载
p = 'src/components/SettingsPanel.tsx'
s = io.open(p, encoding='utf-8').read()
old_mount = "      {/* 内容规范（2026-09-01 刘总）：全局表达章程，全场景通用 */}\n      <ContentCharterSection />"
assert old_mount in s, 'mount anchor'
s = s.replace(old_mount + '\n', '')
old_imp = "import ContentCharterSection from './ContentCharterSection';\n"
assert old_imp in s
s = s.replace(old_imp, '')
io.open(p, 'w', encoding='utf-8', newline=chr(10)).write(s)
print('settings mount removed')

# 2. App.tsx：StandalonePage 类型 + lazy + 顶栏按钮 + renderPage 分支
p = 'src/App.tsx'
s = io.open(p, encoding='utf-8').read()

old_type = "type StandalonePage = 'dashboard' | 'goal' | 'timeline' | 'latex' | 'experiments' | 'evals' | 'kanban' | 'outcomes' | 'submissions';"
assert old_type in s
s = s.replace(old_type, "type StandalonePage = 'dashboard' | 'goal' | 'timeline' | 'latex' | 'experiments' | 'evals' | 'kanban' | 'outcomes' | 'submissions' | 'charter';")

old_lazy = "const SubmissionsPage = lazy(() => import('./pages/SubmissionWorkspacePage'));"
assert old_lazy in s
s = s.replace(old_lazy, old_lazy + "\nconst ContentCharterPage = lazy(() => import('./pages/ContentCharterPage'));")

# renderPage：personalizationOpen 分支后加 charter 分支
old_render = """  function renderPage() {
    if (personalizationOpen) {
      return <PersonalizationCenter onActivateScenario={activatePersonalizationScenario} />;
    }"""
new_render = """  function renderPage() {
    if (charterOpen) {
      return <ContentCharterPage />;
    }
    if (personalizationOpen) {
      return <PersonalizationCenter onActivateScenario={activatePersonalizationScenario} />;
    }"""
assert old_render in s
s = s.replace(old_render, new_render)

# 顶栏按钮：场景（PREFERENCE_NAV_ITEMS）按钮组渲染之后插入内容规范按钮
old_pref_end = """                  >{t(item.labelKey)}</button>
              );
            })}
          </div>
        </nav>"""
new_pref_end = """                  >{t(item.labelKey)}</button>
              );
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
assert old_pref_end in s
s = s.replace(old_pref_end, new_pref_end)

# state：charterOpen（挂在 personalizationOpen state 旁）
import re
m = re.search(r"const \[personalizationOpen, setPersonalizationOpen\] = useState\(([^)]*)\);", s)
assert m, 'personalizationOpen state'
s = s.replace(m.group(0), m.group(0) + "\n  const [charterOpen, setCharterOpen] = useState(false);", 1)

# 其他导航点击时关闭 charterOpen：leavePersonalizationGuard 回调里已 setPersonalizationOpen(false)——
# 在这些回调中同时关闭 charter 会在十几处重复；改为在 renderPage 之外的用户动作之外——
# 最简：顶栏其他按钮的 onClick 已有 setStandalonePage(null) 等，charter 关闭交给
# 「点击任何其他导航时也应关闭」——在 leavePersonalizationGuard 的所有调用处逐个加太散，
# 改为全局监听：currentEntry 变化时关闭 charter。
old_watch = "  const [charterOpen, setCharterOpen] = useState(false);"
new_watch = old_watch + """
  useEffect(() => {
    if (charterOpen && currentEntry !== 'projects') setCharterOpen(false);
  }, [charterOpen, currentEntry]);"""
s = s.replace(old_watch, new_watch)

io.open(p, 'w', encoding='utf-8', newline=chr(10)).write(s)
print('app wired')
