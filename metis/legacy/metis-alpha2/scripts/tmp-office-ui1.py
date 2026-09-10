import io

# ── preload 桥 ──
p = 'electron/preload.ts'
s = io.open(p, encoding='utf-8').read()
anchor = "  officePromptSetSlot: async (request: { profileId: string; slotId: string; content: string }) => ("
assert anchor in s, 'preload anchor'
bridges = """  officePromptGetGlobal: async (request: { officeKind: string; outcomeId?: string | null }) =>
    ipcRenderer.invoke('officePrompt:getGlobal', request) as Promise<string | null>,
  officePromptSetGlobal: async (request: { profileId: string; content: string }) =>
    ipcRenderer.invoke('officePrompt:setGlobal', request) as Promise<Record<string, unknown> | null>,
""" + anchor
s = s.replace(anchor, bridges, 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('preload bridges added')
