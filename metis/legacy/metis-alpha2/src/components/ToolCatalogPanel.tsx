/**
 * ToolCatalogPanel — browse the agent's builtin tool catalog by category.
 */

import { useTranslation } from '../i18n';
import { getFileToolSpecs } from '@engine/tools/builtin/file-tools.js';
import { getSearchToolSpecs } from '@engine/tools/builtin/search-tools.js';
import { getShellToolSpecs } from '@engine/tools/builtin/shell-tools.js';
import { getResearchToolSpecs } from '@engine/tools/builtin/research-tools.js';
import { getEvidenceToolSpecs } from '@engine/tools/builtin/evidence-tools.js';
import { PLUGIN_TOOLS } from '@engine/tools/builtin/PluginMarketplace.js';
import { ACADEMIC_TOOL_SPECS } from '@engine/tools/builtin/academic-tools.js';
import { MULTI_AGENT_TOOL } from '@engine/tools/builtin/MultiAgentTool.js';
import type { ToolSpec } from '@engine/core/types.js';

interface ToolCategory {
  id: string;
  tools: ToolSpec[];
}

function permissionLevel(tool: ToolSpec): 'read' | 'write' | 'execute' | 'network' {
  if (tool.name.includes('execute') || tool.name.includes('write') || tool.name.includes('create') || tool.name.includes('delete')) return 'write';
  if (tool.name.includes('search') || tool.name.includes('lookup') || tool.name.includes('import') || tool.name.includes('arxiv') || tool.name.includes('crossref') || tool.name.includes('openalex')) return 'network';
  if (tool.name.includes('command')) return 'execute';
  return 'read';
}

export function ToolCatalogPanel() {
  const { t } = useTranslation();
  const categories: ToolCategory[] = [
    { id: 'file', tools: getFileToolSpecs() },
    { id: 'search', tools: getSearchToolSpecs() },
    { id: 'shell', tools: getShellToolSpecs() },
    { id: 'research', tools: getResearchToolSpecs() },
    { id: 'evidence', tools: getEvidenceToolSpecs() },
    { id: 'plugin', tools: PLUGIN_TOOLS },
    { id: 'academic', tools: ACADEMIC_TOOL_SPECS },
    { id: 'multiagent', tools: [MULTI_AGENT_TOOL] },
  ];
  const total = categories.reduce((sum, c) => sum + c.tools.length, 0);

  return (
    <div className="tool-catalog-panel">
      <div className="tool-catalog-header">
        <h3>{t('tools.catalogTitle')}</h3>
        <span className="tool-catalog-count">{t('tools.catalogCount', { count: total })}</span>
      </div>
      {categories.map((category) => (
        <div key={category.id} className="tool-catalog-category">
          <h4>{t(`tools.category_${category.id}`)} <span className="tool-catalog-count">({category.tools.length})</span></h4>
          <ul className="tool-catalog-list">
            {category.tools.map((tool) => (
              <li key={tool.name} className="tool-catalog-item">
                <div className="tool-catalog-item__name">
                  <code>{tool.name}</code>
                  <span className={`tool-permission tool-permission--${permissionLevel(tool)}`}>
                    {permissionLevel(tool)}
                  </span>
                </div>
                <div className="tool-catalog-item__description">{tool.description}</div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
