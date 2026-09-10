/**
 * SettingsDiagnosticSection — MCP servers + HITL approval rules.
 *
 * Only rendered when diagnostic mode is enabled. Migrated from the
 * inline App.tsx SettingsPage. Contains all MCP add/remove/toggle/test
 * and HITL rule toggle functionality.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from '../i18n';
import SettingsHealthSection from './SettingsHealthSection.js';

interface McpServer {
  id: string;
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

interface HitlRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export default function SettingsDiagnosticSection() {
  const { t } = useTranslation();

  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [hitlRules, setHitlRules] = useState<HitlRule[]>([]);

  async function loadMCPServers() {
    const metis = window.metis;
    if (metis?.listMCPServers) {
      try {
        const servers = await metis.listMCPServers();
        setMcpServers(servers);
      } catch (err) { console.warn('Failed to load MCP servers:', err); }
    }
  }

  async function loadHitlRules() {
    const metis = window.metis;
    if (metis?.listHITLRules) {
      try {
        const rules = await metis.listHITLRules();
        setHitlRules(rules);
      } catch (err) { console.warn('Failed to load HITL rules:', err); }
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async loaders, setState in .then()
    void loadMCPServers();
    void loadHitlRules();
  }, []);

  const handleRemoveMcpServer = async (id: string) => {
    const metis = window.metis;
    if (!metis?.removeMCPServer) return;
    try {
      await metis.removeMCPServer(id);
      await loadMCPServers();
    } catch (err) { console.warn('Failed to remove MCP server:', err); }
  };

  const handleDisableMcpServer = async (id: string) => {
    const metis = window.metis;
    if (!metis?.toggleMCPServer) return;
    try {
      await metis.toggleMCPServer(id, false);
      await loadMCPServers();
    } catch (err) { console.warn('Failed to disable MCP server:', err); }
  };

  const handleToggleHitlRule = async (id: string, enabled: boolean) => {
    const metis = window.metis;
    if (!metis?.toggleHITLRule) return;
    try {
      await metis.toggleHITLRule(id, !enabled);
      await loadHitlRules();
    } catch (err) { console.warn('Failed to toggle HITL rule:', err); }
  };

  return (
    <>
      <SettingsHealthSection />
      <div className="settings-group" data-testid="diagnostic-mcp-settings">
        <h3>{t('settings.mcpServers')}</h3>
        <p>{t('settings.mcpServersDescription')}</p>

        {mcpServers.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.mcpServerNoServers')}</p>
        )}

        {mcpServers.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            {mcpServers.map((srv) => (
              <div key={srv.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
                border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8,
                background: 'var(--bg-secondary)',
              }}>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: srv.connected ? 'var(--status-completed)' : srv.error ? 'var(--status-failed)' : 'var(--text-secondary)',
                }} />
                <span style={{ fontWeight: 500, flex: 1 }}>{srv.name}</span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {srv.connected
                    ? t('settings.mcpServerTools').replace('{count}', String(srv.toolCount))
                    : srv.error
                      ? t('settings.mcpServerStatusError')
                      : t('settings.mcpServerStatusDisconnected')}
                </span>
                {srv.connected && (
                  <button
                    className="btn-secondary"
                    style={{ fontSize: 12, padding: '4px 8px' }}
                    onClick={() => handleDisableMcpServer(srv.id)}
                  >
                    {t('common.disable')}
                  </button>
                )}
                <button
                  className="btn-secondary"
                  style={{ fontSize: 12, padding: '4px 8px', color: 'var(--status-failed)' }}
                  onClick={() => handleRemoveMcpServer(srv.id)}
                >
                  {t('settings.mcpServerDelete')}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Read-only managed-installer notice: direct add/test forms were removed
            because the backend refuses them (managed_mcp_required). Server
            installation lives in the managed installer (Scenarios → MCP). */}
        <div
          className="mcp-managed-notice"
          style={{
            border: '1px solid var(--border)', borderRadius: 8, padding: 12,
            background: 'var(--bg-secondary)', marginTop: 12, fontSize: 13,
            color: 'var(--text-secondary)', lineHeight: 1.6,
          }}
        >
          <p style={{ margin: '0 0 8px' }}>{t('settings.mcpManagedNotice')}</p>
          <button
            className="btn-secondary"
            data-testid="mcp-open-managed-installer"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('metis:open-mcp-installer'));
            }}
          >
            {t('settings.mcpOpenManagedInstaller')}
          </button>
        </div>
      </div>
      <div className="settings-group" data-testid="diagnostic-hitl-settings">
        <h3>{t('settings.hitlRules')}</h3>
        <p>{t('settings.hitlRulesDescription')}</p>

        {hitlRules.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.hitlRulesNoRules')}</p>
        )}

        {hitlRules.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {hitlRules.map((rule) => (
              <div
                key={rule.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
                  border: '1px solid var(--border)', borderRadius: 6,
                  background: 'var(--bg-secondary)',
                }}
              >
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: rule.enabled ? 'var(--status-completed)' : 'var(--text-secondary)',
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{rule.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{rule.description}</div>
                </div>
                <button
                  className="btn-secondary"
                  style={{ fontSize: 12, padding: '4px 8px' }}
                  onClick={() => handleToggleHitlRule(rule.id, rule.enabled)}
                  data-testid={`hitl-toggle-${rule.id}`}
                >
                  {rule.enabled ? t('common.disable') : t('common.enable')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
