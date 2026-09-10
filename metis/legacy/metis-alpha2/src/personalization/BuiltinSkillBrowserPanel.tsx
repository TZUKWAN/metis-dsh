/**
 * BuiltinSkillBrowserPanel — browse the engine's built-in skills and plugin
 * tools directly from the Personalization Center.
 *
 * DEFAULT_SKILLS (engine/skills/SkillRegistry) and PLUGIN_TOOLS
 * (engine/tools/builtin/PluginMarketplace) are renderer-safe pure data, so a
 * read-only browse panel costs no IPC and no new services. Cards reuse the
 * existing personalization-card CSS classes.
 */

import { useTranslation } from '../i18n';
import { DEFAULT_SKILLS } from '@engine/skills/SkillRegistry.js';
import { PLUGIN_TOOLS } from '@engine/tools/builtin/PluginMarketplace.js';

export function BuiltinSkillBrowserPanel() {
  const { t } = useTranslation();

  return (
    <div className="personalization-installer">
      <div className="personalization-installer__header">
        <h4>{t('personalization.browseBuiltinTitle')}</h4>
        <p className="personalization-installer__hint">
          {t('personalization.browseBuiltinHint')}
        </p>
      </div>

      <h5 className="personalization-browse-section">{t('personalization.browseSkillsSection')}</h5>
      <div className="personalization-cards">
        {DEFAULT_SKILLS.map((skill) => (
          <article key={skill.id} className="personalization-card">
            <div className="personalization-card__body">
              <div className="personalization-card__meta">
                <span>{skill.category}</span>
              </div>
              <strong>{skill.name}</strong>
              <span className="personalization-card__description">{skill.description}</span>
              {skill.tags && skill.tags.length > 0 && (
                <div className="personalization-card__tags">
                  {skill.tags.map((tag) => (
                    <span key={tag} className="personalization-tag">{tag}</span>
                  ))}
                </div>
              )}
            </div>
          </article>
        ))}
      </div>

      <h5 className="personalization-browse-section">{t('personalization.browseToolsSection')}</h5>
      <div className="personalization-cards">
        {PLUGIN_TOOLS.map((tool) => (
          <article key={tool.name} className="personalization-card">
            <div className="personalization-card__body">
              <div className="personalization-card__meta">
                <span>plugin-tool</span>
              </div>
              <strong>{tool.name}</strong>
              <span className="personalization-card__description">{tool.description}</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
