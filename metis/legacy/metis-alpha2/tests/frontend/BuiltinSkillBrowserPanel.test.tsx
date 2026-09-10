/**
 * @vitest-environment jsdom
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

// The panel imports engine pure-data modules (no Node deps), so no mocks needed.
import { BuiltinSkillBrowserPanel } from '../../src/personalization/BuiltinSkillBrowserPanel';
import { DEFAULT_SKILLS } from '../../engine/skills/SkillRegistry';
import { PLUGIN_TOOLS } from '../../engine/tools/builtin/PluginMarketplace';

describe('BuiltinSkillBrowserPanel', () => {
  it('renders a card for every built-in skill', () => {
    const { container } = render(<BuiltinSkillBrowserPanel />);
    // Each skill card carries the skill's name as strong text.
    for (const skill of DEFAULT_SKILLS) {
      const found = Array.from(container.querySelectorAll('strong')).some((el) => el.textContent === skill.name);
      expect(found).toBe(true);
    }
  });

  it('renders a card for every plugin tool', () => {
    const { container } = render(<BuiltinSkillBrowserPanel />);
    for (const tool of PLUGIN_TOOLS) {
      const found = Array.from(container.querySelectorAll('strong')).some((el) => el.textContent === tool.name);
      expect(found).toBe(true);
    }
  });

  it('shows the section headings', () => {
    const { container } = render(<BuiltinSkillBrowserPanel />);
    // Two section headings render as h5 elements regardless of locale text.
    const headings = container.querySelectorAll('h5.personalization-browse-section');
    expect(headings.length).toBe(2);
  });
});
