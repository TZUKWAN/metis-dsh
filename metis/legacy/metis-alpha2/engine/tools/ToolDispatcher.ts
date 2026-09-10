/**
 * Tool dispatcher — validates arguments, enforces guardrails, executes tools.
 *
 * Ported from metis/tools/dispatcher.py.
 */

import type { ToolCall, ToolResult, ToolContext } from '../core/types.js';
import type { HookBus, HookContext } from '../core/HookBus.js';
import { ToolRegistry } from './ToolRegistry.js';
import { ResultStore } from './ResultStore.js';
import { TOOL_EXECUTION_TIMEOUT } from '../core/Config.js';
import { buildArgsDecoder, UnsupportedSchemaError } from './ArgsValidator.js';

/**
 * Detect handler return values that represent errors but were returned as
 * strings instead of being thrown. Matches the prevalent "Error: ..." and
 * "... failed: ..." patterns in academic-tools.ts handlers.
 */
function isErrorResult(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  // Explicit "Error:" prefix (used by most handler validations)
  if (/^\s*Error\s*:/i.test(value)) return true;
  // "Xxx failed: ..." pattern (caught errors)
  if (/[A-Za-z]+\s+failed\s*:/i.test(value) && value.length < 500) return true;
  // "No handler registered" / "Unknown tool" dispatcher errors
  if (value.startsWith('No handler registered') || value.startsWith('Unknown tool')) return true;
  return false;
}

export type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<string>;

export class ToolDispatcher {
  private readonly registry: ToolRegistry;
  private readonly hooks?: HookBus;
  private readonly resultStore: ResultStore;
  private readonly handlers = new Map<string, ToolHandler>();

  constructor(registry: ToolRegistry, hooks?: HookBus, resultStore?: ResultStore) {
    this.registry = registry;
    this.hooks = hooks;
    this.resultStore = resultStore ?? new ResultStore();
  }

  /** Register a handler implementation for a tool name. */
  registerHandler(name: string, handler: ToolHandler): void {
    if (this.handlers.has(name)) {
      throw new Error(`Duplicate handler registration: ${name}`);
    }
    this.handlers.set(name, handler);
  }

  /** Dispatch a tool call: validate → guardrail → execute → store result. */
  async dispatch(call: ToolCall, context?: ToolContext): Promise<ToolResult> {
    const ctx = context ?? { sessionId: 'default', workspace: '.', turnIndex: 0 };
    const spec = this.registry.get(call.name);

    if (!spec) {
      return this.errorResult(call, `Unknown tool: ${call.name}`);
    }

    const handler = this.handlers.get(call.name);
    if (!handler) {
      return this.errorResult(call, `No handler registered for tool: ${call.name}`);
    }

    // Runtime argument validation via per-tool decoder, falling back to the
    // JSON Schema structural validator so every registered tool is validated.
    let validatedArgs: Record<string, unknown>;
    try {
      const decode = spec.decodeArgs ?? buildArgsDecoder(spec.parameters);
      validatedArgs = decode(call.arguments);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid tool arguments';
      if (err instanceof UnsupportedSchemaError) {
        return this.errorResult(call, `Argument validation failed: ${msg}`, 'validation_unavailable');
      }
      return this.errorResult(call, `Argument validation failed: ${msg}`);
    }

    // Pre-dispatch hook
    await this.hooks?.emitAsync('tool.pre_dispatch', { toolName: call.name, arguments: validatedArgs, context: ctx } as unknown as HookContext);

    try {
      const result = await this.executeWithTimeout(handler, validatedArgs, ctx);

      // Handler returned an error string instead of throwing — convert to error status.
      if (isErrorResult(result)) {
        const code = typeof result === 'string' && result.length > 0 ? 'handler_error' : undefined;
        const toolResult = this.errorResult(call, result, code);
        this.resultStore.save(call.id, toolResult);
        await this.hooks?.emitAsync('tool.post_dispatch', { toolName: call.name, result: toolResult, context: ctx } as unknown as HookContext);
        return toolResult;
      }

      const toolResult: ToolResult = {
        toolName: call.name,
        content: result,
        status: 'ok',
        toolCallId: call.id,
        metadata: {},
      };

      this.resultStore.save(call.id, toolResult);

      // Post-dispatch hook
      await this.hooks?.emitAsync('tool.post_dispatch', { toolName: call.name, result: toolResult, context: ctx } as unknown as HookContext);

      return toolResult;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const toolResult = this.errorResult(call, errorMsg);

      // Error hook
      await this.hooks?.emitAsync('tool.error', { toolName: call.name, error: errorMsg, context: ctx } as unknown as HookContext);

      return toolResult;
    }
  }

  getResultStore(): ResultStore {
    return this.resultStore;
  }

  // ─── Internals ─────────────────────────────────────────────

  private async executeWithTimeout(
    handler: ToolHandler,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const signal = context.signal;
      const cleanup = () => {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = <T>(complete: (value: T) => void, value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        complete(value);
      };
      const onAbort = () => {
        settle(reject, new Error('Tool execution aborted'));
      };

      const timeoutId = setTimeout(
        () => settle(reject, new Error(`Tool execution timeout (${TOOL_EXECUTION_TIMEOUT}s)`)),
        TOOL_EXECUTION_TIMEOUT * 1000,
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        handler(args, context).then(
          (result) => settle(resolve, result),
          (error: unknown) => settle(reject, error),
        );
      } catch (error) {
        settle(reject, error);
      }
    });
  }

  private errorResult(call: ToolCall, error: string, code?: string): ToolResult {
    return {
      toolName: call.name,
      content: '',
      status: 'error',
      toolCallId: call.id,
      error,
      metadata: code ? { code } : {},
    };
  }
}
