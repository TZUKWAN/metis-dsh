import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  MCP_ACTIVATION_CONTRACT_VERSION,
  McpActivationIpcRequestSchema,
  decodeMcpActivationResponse,
  type McpActivationIpcRequest,
} from '../../engine/runtime/McpActivationContract.js';
import {
  McpDefinitionSchema,
  type McpDefinition,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { useTranslation } from '../i18n';
import './McpActivationPanel.css';

const MANAGED_MCP_COMMAND = 'metis-managed-mcp';
const TOOL_SUMMARY_LIMIT = 5;
const COPY = {
  zh: {
    region: 'MCP 激活',
    heading: '验证 MCP',
    description: '执行一次受限启动并读取工具清单；验证通过后自动激活。',
    failure: (code: string) => `激活失败。MCP 保持禁用状态。（${code}）`,
    success: '激活成功',
    activated: (count: number) => `已验证并激活 ${count} 个工具。`,
    tools: '已激活工具摘要',
    remaining: (count: number) => `另有 ${count} 个工具。`,
    busy: '正在验证…',
    action: '验证并激活',
  },
  en: {
    region: 'MCP activation',
    heading: 'Verify MCP',
    description: 'Runs one restricted startup and reads the tool list. Metis activates it only after verification succeeds.',
    failure: (code: string) => `Activation failed. The MCP remains disabled. (${code})`,
    success: 'Activation succeeded',
    activated: (count: number) => `Verified and activated ${count} ${count === 1 ? 'tool' : 'tools'}.`,
    tools: 'Activated tool summary',
    remaining: (count: number) => `${count} additional ${count === 1 ? 'tool' : 'tools'}.`,
    busy: 'Verifying…',
    action: 'Verify and activate',
  },
} as const;

export interface McpActivationPanelDependencies {
  createOperationId?: () => string;
  activateMcp(request: McpActivationIpcRequest): Promise<unknown>;
}

export interface McpActivationPanelProps {
  definition: McpDefinition;
  dependencies: McpActivationPanelDependencies;
  onActivated?: (definition: McpDefinition) => void;
}

interface ActivationTarget {
  definition: McpDefinition;
  installationId: string;
  binding: string;
}

type PanelOutcome =
  | { binding: string; state: 'idle' | 'busy' }
  | { binding: string; state: 'failure'; code: string }
  | { binding: string; state: 'success'; tools: readonly string[] };

function activationTarget(raw: McpDefinition): ActivationTarget | null {
  const parsed = McpDefinitionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const definition = parsed.data;
  const localPackage = definition.sourceMode === 'package'
    && definition.id.startsWith('user:mcp/')
    && definition.provenance.origin === 'user'
    && definition.sourceUrl === null
    && definition.provenance.sourceUrl === null;
  const remotePackage = definition.sourceMode === 'url'
    && definition.id.startsWith('url:mcp/')
    && definition.provenance.origin === 'url'
    && definition.sourceUrl !== null
    && definition.sourceUrl === definition.provenance.sourceUrl;
  if (definition.enabled
    || (!localPackage && !remotePackage)
    || definition.command !== MANAGED_MCP_COMMAND
    || definition.args.length !== 1
    || definition.exposedTools.length !== 0
    || Object.keys(definition.environment).length !== 0
    || !definition.tags.includes('pending-probe')
    || definition.tags.includes('probe-verified')) return null;
  const installationId = definition.args[0];
  if (!installationId
    || definition.workingDirectoryToken !== installationId
    || definition.provenance.sourceRevision !== installationId
    || definition.provenance.installedDigest === null) return null;
  return {
    definition,
    installationId,
    binding: `${definition.id}@${definition.revision}:${installationId}`,
  };
}

function operationId(factory?: () => string): string | null {
  try {
    return factory ? factory() : crypto.randomUUID();
  } catch {
    return null;
  }
}

function responseMatchesRequest(
  response: ReturnType<typeof decodeMcpActivationResponse>,
  request: McpActivationIpcRequest,
): response is Extract<ReturnType<typeof decodeMcpActivationResponse>, { ok: true }> {
  return response.ok
    && response.operationId === request.operationId
    && response.definition.id === request.definitionId
    && response.definition.revision === request.expectedRevision + 1
    && response.installation.installationId === request.installationId;
}

export default function McpActivationPanel({
  definition,
  dependencies,
  onActivated,
}: McpActivationPanelProps) {
  const { locale } = useTranslation();
  const copy = COPY[locale];
  const target = useMemo(() => activationTarget(definition), [definition]);
  const binding = target?.binding ?? '';
  const latestBinding = useRef(binding);
  const inFlightBinding = useRef<string | null>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const [outcome, setOutcome] = useState<PanelOutcome>({ binding: '', state: 'idle' });

  useLayoutEffect(() => {
    latestBinding.current = binding;
  }, [binding]);

  // Error feedback is an assertive, keyboard-focusable recovery point.  Move
  // focus in the layout phase so it is ready with the committed alert instead
  // of leaving the user on the prior control for a paint/effect turn.
  useLayoutEffect(() => {
    if (outcome.binding === binding && outcome.state === 'failure') alertRef.current?.focus();
  }, [binding, outcome]);

  if (!target) return null;

  const current = outcome.binding === binding
    ? outcome
    : { binding, state: 'idle' as const };
  const busy = outcome.state === 'busy';

  const activate = async () => {
    if (inFlightBinding.current !== null) return;
    const nextOperationId = operationId(dependencies.createOperationId);
    const request = McpActivationIpcRequestSchema.safeParse({
      contractVersion: MCP_ACTIVATION_CONTRACT_VERSION,
      operationId: nextOperationId,
      definitionId: target.definition.id,
      installationId: target.installationId,
      expectedRevision: target.definition.revision,
    });
    if (!request.success) {
      setOutcome({ binding, state: 'failure', code: 'invalid_request' });
      return;
    }

    inFlightBinding.current = binding;
    setOutcome({ binding, state: 'busy' });
    try {
      const response = decodeMcpActivationResponse(await dependencies.activateMcp(request.data));
      if (latestBinding.current !== binding) {
        setOutcome({ binding: latestBinding.current, state: 'idle' });
        return;
      }
      if (!response.ok) {
        setOutcome({ binding, state: 'failure', code: response.code });
        return;
      }
      if (!responseMatchesRequest(response, request.data)) {
        setOutcome({ binding, state: 'failure', code: 'invalid_response' });
        return;
      }
      setOutcome({ binding, state: 'success', tools: [...response.definition.exposedTools] });
      try {
        onActivated?.(response.definition);
      } catch {
        // A consumer callback cannot alter the already committed activation result.
      }
    } catch {
      if (latestBinding.current === binding) setOutcome({ binding, state: 'failure', code: 'invalid_response' });
    } finally {
      if (inFlightBinding.current === binding) inFlightBinding.current = null;
    }
  };

  const tools = current.state === 'success' ? current.tools : [];
  const summarizedTools = tools.slice(0, TOOL_SUMMARY_LIMIT);
  const remainingTools = tools.length - summarizedTools.length;

  return (
    <section className="mcp-activation-panel" role="region" aria-label={copy.region}>
      <div className="mcp-activation-panel__copy">
        <h3>{copy.heading}</h3>
        <p>{copy.description}</p>
      </div>

      {current.state === 'failure' && (
        <p
          ref={alertRef}
          className="mcp-activation-panel__alert"
          role="alert"
          aria-live="assertive"
          tabIndex={-1}
        >
          {copy.failure(current.code)}
        </p>
      )}

      {current.state === 'success' ? (
        <div className="mcp-activation-panel__success" role="status" aria-live="polite">
          <strong>{copy.success}</strong>
          <span>{copy.activated(tools.length)}</span>
          <ul aria-label={copy.tools}>
            {summarizedTools.map((tool) => <li key={tool}>{tool}</li>)}
          </ul>
          {remainingTools > 0 && <span>{copy.remaining(remainingTools)}</span>}
        </div>
      ) : (
        <button
          type="button"
          className="mcp-activation-panel__action"
          disabled={busy}
          aria-busy={busy}
          onClick={() => { void activate(); }}
        >
          {busy ? copy.busy : copy.action}
        </button>
      )}
    </section>
  );
}
