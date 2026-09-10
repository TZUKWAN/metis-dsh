/**
 * @vitest-environment jsdom
 */

import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ToolCatalogPanel } from '../../src/components/ToolCatalogPanel';
import { getFileToolSpecs } from '@engine/tools/builtin/file-tools.js';
import { getSearchToolSpecs } from '@engine/tools/builtin/search-tools.js';
import { getResearchToolSpecs } from '@engine/tools/builtin/research-tools.js';
import { getEvidenceToolSpecs } from '@engine/tools/builtin/evidence-tools.js';
import { PLUGIN_TOOLS } from '@engine/tools/builtin/PluginMarketplace.js';
import { ACADEMIC_TOOL_SPECS } from '@engine/tools/builtin/academic-tools.js';
import { MULTI_AGENT_TOOL } from '@engine/tools/builtin/MultiAgentTool.js';

describe('ToolCatalogPanel', () => {
  it('renders every builtin tool by name', () => {
    const { container } = render(<ToolCatalogPanel />);
    const allTools = [
      ...getFileToolSpecs(),
      ...getSearchToolSpecs(),
      ...getResearchToolSpecs(),
      ...getEvidenceToolSpecs(),
      ...PLUGIN_TOOLS,
      ...ACADEMIC_TOOL_SPECS,
      MULTI_AGENT_TOOL,
    ];
    for (const tool of allTools) {
      const found = Array.from(container.querySelectorAll('code')).some((el) => el.textContent === tool.name);
      expect(found).toBe(true);
    }
  });

  it('shows the total tool count in the header', () => {
    const { container } = render(<ToolCatalogPanel />);
    const header = container.querySelector('.tool-catalog-header');
    expect(header).toBeTruthy();
    expect(header!.querySelector('.tool-catalog-count')).toBeTruthy();
  });

  it('groups tools by category with at least 4 categories', () => {
    const { container } = render(<ToolCatalogPanel />);
    const categories = container.querySelectorAll('.tool-catalog-category');
    expect(categories.length).toBeGreaterThanOrEqual(4);
  });
});
