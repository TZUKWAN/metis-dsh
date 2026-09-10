import { useState } from 'react';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import SettingsBackupSection from './SettingsBackupSection';
import CloudSyncSection from './CloudSyncSection';
import SettingsDiagnosticSection from './SettingsDiagnosticSection';
import SettingsMarketTokensSection from './SettingsMarketTokensSection';

type AdvancedTab = 'backup' | 'cloudSync' | 'issn' | 'tokens' | 'diagnostics';

const TABS: Array<{ id: AdvancedTab; label: string }> = [
  { id: 'backup', label: '数据备份' },
  { id: 'cloudSync', label: '云备份 (WebDAV)' },
  { id: 'issn', label: '核心期刊白名单' },
  { id: 'tokens', label: '市场 / 集成令牌' },
  { id: 'diagnostics', label: '开发者诊断' },
];

export interface SettingsAdvancedDialogProps {
  open: boolean;
  onClose: () => void;
  uiMode: UIMode;
  issnNotice: string;
  onIssnImport: () => void;
}

export default function SettingsAdvancedDialog({
  open,
  onClose,
  uiMode,
  issnNotice,
  onIssnImport,
}: SettingsAdvancedDialogProps) {
  const [activeTab, setActiveTab] = useState<AdvancedTab>('backup');
  if (!open) return null;

  return (
    <div className="settings-advanced-overlay" role="presentation">
      <section className="settings-advanced-dialog" role="dialog" aria-modal="true" aria-label="高级设置">
        <header className="settings-advanced-header">
          <h3>高级设置</h3>
          <button type="button" className="settings-advanced-close" onClick={onClose} aria-label="关闭" data-testid="advanced-settings-close">×</button>
        </header>
        <nav className="settings-advanced-tabs" aria-label="高级设置分类">
          {TABS.map((tab) => (
            <button key={tab.id} type="button" className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)}>
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="settings-advanced-body" data-testid={'advanced-tab-' + activeTab}>
          {activeTab === 'backup' && <SettingsBackupSection uiMode={uiMode} />}
          {activeTab === 'cloudSync' && <CloudSyncSection />}
          {activeTab === 'issn' && (
            <div className="settings-group" data-testid="issn-import-section" data-settings-section="issn-import">
              <h3>核心期刊白名单</h3>
              <p className="cloud-sync__hint">导入核心期刊目录，用于文献筛选与投稿参考。支持 ISSN 列表文件批量导入。</p>
              <button type="button" className="btn-secondary btn-sm" onClick={onIssnImport} data-testid="issn-import-button">导入期刊列表</button>
              {issnNotice && <div role="status" data-testid="issn-import-notice" className="cloud-sync__notice">{issnNotice}</div>}
            </div>
          )}
          {activeTab === 'tokens' && <SettingsMarketTokensSection />}
          {activeTab === 'diagnostics' && <SettingsDiagnosticSection />}
        </div>
      </section>
    </div>
  );
}
