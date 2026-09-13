# Prepare GUI black-box acceptance environment.
import os

metis_dir = r'D:\LATEXTEST\METIS4DSH\deepseek-harness\metis'
gui_dir = os.path.join(metis_dir, 'tests', 'gui')
os.makedirs(gui_dir, exist_ok=True)

sep = chr(92)
fwd = lambda p: p.replace(sep, '/')

plugin_rows = []
for name in ['core', 'evidence', 'literature', 'scenario', 'artifact']:
    p = fwd(os.path.join(metis_dir, 'plugins', name, 'src', 'index.ts'))
    plugin_rows.append("    - id: metis-" + name + chr(10) + "      name: 'file:///" + p + "'")
for name in ['literature-crossref', 'literature-openalex', 'literature-ncpssd']:
    p = fwd(os.path.join(metis_dir, 'plugins', name, 'src', 'index.ts'))
    plugin_rows.append("    - id: metis-" + name + chr(10) + "      name: 'file:///" + p + "'")

db = 'C:/METIS-GUI-ACCEPT/metis-data/metis.db'
config_blocks = []
for name in ['metis-core', 'metis-evidence', 'metis-literature', 'metis-scenario', 'metis-artifact']:
    config_blocks.append('-' + chr(10) + '  id: ' + name + chr(10) + '  config:' + chr(10) + "    databasePath: '" + db + "'")

llm = (
    '-' + chr(10) + '  id: llm-pi-ai' + chr(10) + '  config:' + chr(10) + '    providers:' + chr(10) +
    '      cloudlob:' + chr(10) + '        displayName: CloudLob' + chr(10) +
    '        api: openai-completions' + chr(10) +
    '        baseURL: https://cloudlob.xyz/v1' + chr(10) +
    '        apiKeyEnv: CLOUDLOB_API_KEY' + chr(10) +
    '        timeoutMs: 180000' + chr(10) +
    '        models:' + chr(10) +
    '          - id: qwen3.8-flash-bai' + chr(10) +
    '            name: Qwen3.8 Flash' + chr(10) +
    '            contextWindow: 262144' + chr(10) +
    '            maxTokens: 32768'
)
adm = '-' + chr(10) + '  id: agent-default-model' + chr(10) + '  config:' + chr(10) + '    provider: cloudlob' + chr(10) + '    model: qwen3.8-flash-bai'

content = '# GUI black-box acceptance overlay (generated).' + chr(10) + '- insert:' + chr(10) + chr(10).join(plugin_rows) + chr(10) + "    - id: workspace-registry" + chr(10) + "      name: '@deepseek-ai/dsh-workspace'" + chr(10) + chr(10).join(config_blocks) + chr(10) + llm + chr(10) + adm + chr(10)
open(os.path.join(gui_dir, 'gui-overlay.yml'), 'w', encoding='utf-8', newline=chr(10)).write(content)

settings = ('llm-pi-ai:' + chr(10) + '  providers:' + chr(10) + '    cloudlob:' + chr(10) +
            '      displayName: CloudLob' + chr(10) +
            '      api: openai-completions' + chr(10) +
            '      baseURL: https://cloudlob.xyz/v1' + chr(10) +
            '      apiKeyEnv: CLOUDLOB_API_KEY' + chr(10) +
            '      models:' + chr(10) +
            '        - id: qwen3.8-flash-bai' + chr(10) +
            '          name: Qwen3.8 Flash' + chr(10) +
            '          contextWindow: 262144' + chr(10) +
            '          maxTokens: 32768' + chr(10) +
            'agent-default-model:' + chr(10) +
            '  provider: cloudlob' + chr(10) +
            '  model: qwen3.8-flash-bai' + chr(10))
os.makedirs(r'C:\METIS-GUI-ACCEPT\dsh-home', exist_ok=True)
open(r'C:\METIS-GUI-ACCEPT\dsh-home\settings.yaml', 'w', encoding='utf-8', newline=chr(10)).write(settings)
os.makedirs(r'C:\METIS-GUI-ACCEPT\workspace', exist_ok=True)
print('GUI overlay + settings + workspace prepared')
