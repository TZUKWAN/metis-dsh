import { Sparkles } from 'lucide-react';
import { useTranslation } from '../i18n';
import './ScenarioLauncher.css';

export interface ScenarioLauncherProps {
  className?: string;
  onOpenPersonalization?: () => void;
  projectId?: string;
}

/**
 * The planning surface intentionally has no domain templates of its own.
 * Users define every scenario in Personalization and then run it from chat.
 */
export default function ScenarioLauncher({
  className = '',
  onOpenPersonalization,
}: ScenarioLauncherProps) {
  const { locale } = useTranslation();
  const zh = locale === 'zh';

  return (
    <section
      className={`scenario-launcher scenario-launcher--empty ${className}`.trim()}
      aria-labelledby="scenario-launcher-empty-title"
    >
      <div className="scenario-launcher-empty">
        <span className="scenario-launcher-eyebrow">
          <Sparkles size={15} aria-hidden="true" />
          {zh ? '自定义场景' : 'Custom scenarios'}
        </span>
        <h2 id="scenario-launcher-empty-title">
          {zh ? '这里没有预设答案' : 'No scenario is assumed'}
        </h2>
        <p>
          {zh
            ? '请在“场景”中从空白开始，组合你自己的智能体、技能、MCP、工作流与 Metis.md。'
            : 'Start from a blank scenario, then compose your own Agents, Skills, MCPs, workflow, and Metis.md.'}
        </p>
        <button
          type="button"
          className="scenario-launcher-button scenario-launcher-button--primary"
          onClick={onOpenPersonalization}
          disabled={!onOpenPersonalization}
        >
          {zh ? '打开场景' : 'Open Scenarios'}
        </button>
      </div>
    </section>
  );
}
