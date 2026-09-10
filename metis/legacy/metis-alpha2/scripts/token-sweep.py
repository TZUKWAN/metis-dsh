#!/usr/bin/env python3
"""Phase-2 hex sweep: replace literal hex colors in page/shell CSS with theme tokens.

Pass 1: hex/rgb(a) fallbacks inside var(--token, <fallback>) —
        stripped when --token is a globally defined token (theme or polish
        aliases), otherwise the fallback hex is replaced by a token var.
Pass 2: standalone hex literals replaced via a curated mapping.
        #fff is property-aware (color -> --text-on-accent, background -> --bg-card).
Leftovers are printed for manual review.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
THEME = (ROOT / 'src' / 'AcademicTheme.css').read_text(encoding='utf-8')
POLISH = (ROOT / 'src' / 'AcademicPolish.css').read_text(encoding='utf-8')

# Globally defined tokens (theme + polish aliases): fallbacks for these are dead.
GLOBAL_TOKENS = set(re.findall(r'(--[\w-]+)\s*:', THEME)) | set(re.findall(r'(--[\w-]+)\s*:', POLISH))

HEX_MAP = {
    # accent family
    '#1f3a5f': 'var(--accent)', '#236c91': 'var(--accent)', '#26436e': 'var(--accent)',
    '#183b59': 'var(--accent)', '#1e5a9e': 'var(--accent)', '#2563eb': 'var(--accent)',
    '#4a6fa5': 'var(--accent)', '#7aa2d6': 'var(--chart-4)', '#4d79a9': 'var(--chart-4)',
    '#2b6cb0': 'var(--status-reading-text)', '#eef4fb': 'var(--status-reading-bg)',
    # text
    '#17243a': 'var(--text-heading)', '#1c2733': 'var(--text-heading)',
    '#1a1f2e': 'var(--text-heading)', '#0f172a': 'var(--text-heading)',
    '#1d2730': 'var(--text-heading)', '#111': 'var(--text-heading)',
    '#e8e4da': 'var(--text-heading)', '#d1ccc0': 'var(--text-body)',
    '#5a6572': 'var(--text-secondary)', '#526171': 'var(--text-secondary)',
    '#576171': 'var(--text-secondary)', '#4a5568': 'var(--text-secondary)',
    '#5b6874': 'var(--text-secondary)', '#5b7083': 'var(--text-secondary)',
    '#8a94a3': 'var(--text-muted)', '#9aa4b2': 'var(--text-muted)',
    '#7c8698': 'var(--text-muted)', '#87909e': 'var(--text-muted)',
    '#a0aec0': 'var(--text-muted)', '#999': 'var(--text-muted)', '#666': 'var(--text-muted)',
    '#9da9b1': 'var(--text-muted)', '#c8d0dc': 'var(--text-muted)',
    '#718096': 'var(--evidence-stale)',
    # surfaces
    '#f7f9fc': 'var(--bg-subtle)', '#f5f6f8': 'var(--bg-subtle)', '#f8fafc': 'var(--bg-subtle)',
    '#f4f7fa': 'var(--bg-subtle)', '#f3f6f8': 'var(--bg-subtle)', '#fafafa': 'var(--bg-subtle)',
    '#f0f0f0': 'var(--bg-subtle)', '#edf0f2': 'var(--bg-subtle)', '#eef2f5': 'var(--bg-subtle)',
    '#edf2f7': 'var(--bg-hover)', '#f7f8fa': 'var(--status-unread-bg)',
    '#131211': 'var(--bg-main)', '#0f1218': 'var(--bg-main)', '#1b1a16': 'var(--bg-card)',
    '#2c3443': 'var(--bg-hover)',
    # borders
    '#e5e8ef': 'var(--border-light)', '#e2e7eb': 'var(--border-light)',
    '#d8dee6': 'var(--border-light)', '#d7dfe4': 'var(--border-light)',
    '#ddd': 'var(--border-light)', '#34302a': 'var(--border)',
    # status: danger
    '#c53030': 'var(--status-failed)', '#c0392b': 'var(--status-failed)',
    '#b3261e': 'var(--status-failed)', '#d64545': 'var(--status-failed)',
    '#dc3545': 'var(--status-failed)', '#ef4444': 'var(--status-failed)',
    '#e53e3e': 'var(--status-failed)', '#c2410c': 'var(--status-failed)',
    '#9b3d3d': 'var(--status-failed)', '#742a2a': 'var(--status-failed)',
    '#721c24': 'var(--status-failed)', '#f0a1a1': 'var(--status-failed)',
    '#fcecec': 'var(--status-failed-bg)', '#f8d7da': 'var(--status-failed-bg)',
    '#fff5f5': 'var(--status-failed-bg)',
    '#feb2b2': 'color-mix(in srgb, var(--status-failed) 40%, transparent)',
    '#efb8b8': 'color-mix(in srgb, var(--status-failed) 40%, transparent)',
    # status: success
    '#2f855a': 'var(--status-completed)', '#2c8a57': 'var(--status-completed)',
    '#3c8c65': 'var(--status-completed)', '#2e7d32': 'var(--status-completed)',
    '#28a745': 'var(--status-completed)', '#38a169': 'var(--status-completed)',
    '#286548': 'var(--status-completed)', '#2f7d4c': 'var(--status-completed)',
    '#155724': 'var(--status-completed)', '#22543d': 'var(--status-completed)',
    '#22c55e': 'var(--status-completed)', '#86d0aa': 'var(--status-completed)',
    '#9ae6b4': 'var(--status-completed)',
    '#f0fff4': 'var(--status-completed-bg)', '#e8f6ee': 'var(--status-completed-bg)',
    '#d4edda': 'var(--status-completed-bg)',
    '#acd8bf': 'color-mix(in srgb, var(--status-completed) 40%, transparent)',
    # status: pending/warning
    '#744210': 'var(--status-skimmed-text)', '#856404': 'var(--status-skimmed-text)',
    '#765c15': 'var(--status-skimmed-text)', '#89501f': 'var(--status-skimmed-text)',
    '#6b4c25': 'var(--status-skimmed-text)',
    '#b7791f': 'var(--evidence-pending)', '#d69e2e': 'var(--evidence-pending)',
    '#d97706': 'var(--evidence-pending)', '#d09a31': 'var(--evidence-pending)',
    '#c07b17': 'var(--evidence-pending)', '#b8860b': 'var(--evidence-pending)',
    '#8a6d1f': 'var(--evidence-pending)', '#f0ad4e': 'var(--evidence-pending)',
    '#ffc107': 'var(--evidence-pending)', '#f0bd84': 'var(--evidence-pending)',
    '#fbd38d': 'var(--evidence-pending)',
    '#fff8e7': 'var(--status-skimmed-bg)', '#fff8ea': 'var(--status-skimmed-bg)',
    '#fff3cd': 'var(--status-skimmed-bg)', '#fffbeb': 'var(--status-skimmed-bg)',
    '#fffaf0': 'var(--status-skimmed-bg)', '#fff2df': 'var(--status-skimmed-bg)',
    '#f8f1d6': 'var(--status-skimmed-bg)',
    # warm accent / dark terminal fallbacks
    '#e49a72': 'var(--accent-warm)',
    '#1e1e2e': 'var(--bg-card)', '#313244': 'var(--border)', '#181825': 'var(--bg-secondary)',
    '#cdd6f4': 'var(--text-primary)', '#a6adc8': 'var(--text-secondary)',
    '#8aa1b2': 'var(--accent)', '#54778e': 'var(--accent)', '#3f5f73': 'var(--accent)',
    '#7d96a7': 'var(--accent)',
    '#1b7f3b': 'var(--status-completed)', '#a05e03': 'var(--status-skimmed-text)',
    '#000': 'black',
    '#7d8b5a': 'var(--chart-6)', '#5a7d8b': 'var(--chart-4)', '#6b8e5a': 'var(--chart-2)',
    '#f5f7fa': 'var(--bg-subtle)', '#d8dee8': 'var(--border-light)',
    '#172033': 'var(--text-heading)', '#5d687a': 'var(--text-secondary)',
    '#315efb': 'var(--accent)', '#b42318': 'var(--status-failed)',
    '#087443': 'var(--status-completed)', '#8b5a2b': 'var(--accent-warm)',
}

RGBA_MAP = {
    'rgba(31, 58, 95, 0.08)': 'color-mix(in srgb, var(--accent) 8%, transparent)',
    'rgba(35, 108, 145, 0.13)': 'color-mix(in srgb, var(--accent) 13%, transparent)',
    'rgba(35,108,145,.13)': 'color-mix(in srgb, var(--accent) 13%, transparent)',
    'rgba(239, 68, 68, 0.06)': 'color-mix(in srgb, var(--status-failed) 6%, transparent)',
}

HEX_RE = re.compile(r'#[0-9a-fA-F]{3,8}\b')
# innermost var() with a hex fallback:  var(--name, #hex)
VAR_HEX_FB_RE = re.compile(r'var\(\s*(--[\w-]+)\s*,\s*(#[0-9a-fA-F]{3,8})\s*\)')
# innermost var() with an rgb/rgba fallback for a global token
VAR_RGBA_FB_RE = re.compile(r'var\(\s*(--[\w-]+)\s*,\s*(rgba?\([^()]*\))\s*\)')

def map_hex(h: str) -> str:
    return HEX_MAP.get(h.lower(), '')

def pass_var_fallbacks(css: str) -> str:
    def repl_hex(m: re.Match) -> str:
        name, hexv = m.group(1), m.group(2).lower()
        if name in GLOBAL_TOKENS:
            return f'var({name})'
        rep = map_hex(hexv)
        if hexv in ('#fff', '#ffffff'):
            rep = 'var(--bg-card)'
        return f'var({name}, {rep})' if rep else m.group(0)
    def repl_rgba(m: re.Match) -> str:
        name = m.group(1)
        return f'var({name})' if name in GLOBAL_TOKENS else m.group(0)
    prev = None
    while prev != css:
        prev = css
        css = VAR_HEX_FB_RE.sub(repl_hex, css)
        css = VAR_RGBA_FB_RE.sub(repl_rgba, css)
    return css

DECL_RE = re.compile(r'([a-z-]+)\s*:\s*([^;{}]+)', re.I)

def pass_standalone(css: str) -> str:
    # operate declaration-wise so #fff can be property-aware
    for rgba, rep in RGBA_MAP.items():
        css = css.replace(rgba, rep)
    lines = css.split('\n')
    out = []
    for line in lines:
        if '#' not in line:
            out.append(line)
            continue
        def repl(m: re.Match) -> str:
            h = m.group(0).lower()
            if h in ('#fff', '#ffffff'):
                # property-aware: look at the property name preceding this value
                head = line[:m.start()]
                pm = re.search(r'([\w-]+)\s*:\s*(?:[^{};]*)$', head)
                prop = pm.group(1).lower() if pm else ''
                if prop.startswith('color') or prop == 'color':
                    return 'var(--text-on-accent)'
                if 'border' in prop or prop in ('outline', 'outline-color'):
                    return 'var(--border-light)'
                if prop in ('box-shadow', 'text-shadow'):
                    return m.group(0)
                return 'var(--bg-card)'
            return map_hex(h) or m.group(0)
        out.append(HEX_RE.sub(repl, line))
    return '\n'.join(out)

def targets() -> list[Path]:
    files = []
    for sub in ('src/pages', 'src/shell', 'src/research', 'src/personalization', 'src/components', 'src/export'):
        files += sorted((ROOT / sub).glob('*.css'))
    files.append(ROOT / 'src' / 'App.css')
    forbidden = {ROOT / 'src' / 'pages' / 'ChatPage.css'}
    return [f for f in files if f not in forbidden]

def count_hex(text: str) -> int:
    return len(HEX_RE.findall(text))

def main() -> None:
    total_before = total_after = 0
    for path in targets():
        css = path.read_text(encoding='utf-8')
        before = count_hex(css)
        css = pass_var_fallbacks(css)
        css = pass_standalone(css)
        after = count_hex(css)
        if css != path.read_text(encoding='utf-8'):
            path.write_text(css, encoding='utf-8')
        total_before += before
        total_after += after
        print(f'{path.relative_to(ROOT)}: {before} -> {after}')
        if after:
            for i, line in enumerate(css.split('\n'), 1):
                if HEX_RE.search(line):
                    print(f'    L{i}: {line.strip()[:160]}')
    print(f'TOTAL: {total_before} -> {total_after}')

if __name__ == '__main__':
    main()
