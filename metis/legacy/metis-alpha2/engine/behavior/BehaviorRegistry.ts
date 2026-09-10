/**
 * Behavior rules engine — gates and hooks for agent behavior control.
 *
 * Ported from metis/behavior/registry.py + metis/behavior/gates.py + metis/behavior/hooks.py.
 */

// ─── Behavior Gate ────────────────────────────────────────────

export interface BehaviorGate {
  id: string;
  name: string;
  description: string;
  /** Return true to allow, false to block. */
  check: (context: BehaviorContext) => boolean | Promise<boolean>;
  enabled: boolean;
}

export interface BehaviorContext {
  sessionId: string;
  turnIndex: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  message?: string;
  [key: string]: unknown;
}

// ─── Behavior Registry ────────────────────────────────────────

export class BehaviorRegistry {
  private readonly gates: BehaviorGate[] = [];

  /** Register a behavior gate. */
  registerGate(gate: BehaviorGate): void {
    this.gates.push(gate);
  }

  /** Remove a gate by id. */
  removeGate(gateId: string): void {
    const idx = this.gates.findIndex((g) => g.id === gateId);
    if (idx !== -1) this.gates.splice(idx, 1);
  }

  /**
   * Run all enabled gates and return true if all pass.
   */
  async checkAll(context: BehaviorContext): Promise<{ allowed: boolean; blockedBy: string | null }> {
    for (const gate of this.gates) {
      if (!gate.enabled) continue;
      try {
        const passed = await gate.check(context);
        if (!passed) {
          return { allowed: false, blockedBy: gate.name };
        }
      } catch {
        // Gate errors → block by default
        return { allowed: false, blockedBy: `${gate.name} (error)` };
      }
    }
    return { allowed: true, blockedBy: null };
  }

  /** Get all registered gates. */
  getGates(): BehaviorGate[] {
    return [...this.gates];
  }

  /** Enable/disable a gate. */
  setGateEnabled(gateId: string, enabled: boolean): void {
    const gate = this.gates.find((g) => g.id === gateId);
    if (gate) gate.enabled = enabled;
  }
}

// ─── Built-in Behavior Gates ──────────────────────────────────

export const MAX_TURNS_GATE: BehaviorGate = {
  id: 'max-turns-gate',
  name: 'Max Turns Guard',
  description: 'Block execution if turn count exceeds limit',
  check: (ctx: BehaviorContext) => {
    const maxTurns = (ctx.maxTurns as number) ?? 20;
    return ctx.turnIndex < maxTurns;
  },
  enabled: true,
};

export const TOOL_SAFETY_GATE: BehaviorGate = {
  id: 'tool-safety-gate',
  name: 'Tool Safety Guard',
  description: 'Block dangerous tool patterns',
  check: (ctx: BehaviorContext) => {
    if (ctx.toolName === 'execute_command') {
      const cmd = String(ctx.toolArgs?.command ?? '').toLowerCase();
      const blocked = ['rm -rf /', 'format c:', 'del /s /q c:\\'];
      return !blocked.some((p) => cmd.includes(p));
    }
    return true;
  },
  enabled: true,
};
