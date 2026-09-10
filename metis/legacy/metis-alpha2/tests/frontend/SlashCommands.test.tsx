/**
 * Slash command parsing and filtering.
 */

import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS, matchSlashCommand, filterSlashCommands } from '../../src/lib/slashCommands.js';

describe('slash commands', () => {
  it('defines all expected commands', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain('chat');
    expect(names).toContain('goal');
    expect(names).toContain('task');
    expect(names).toContain('scenario');
    expect(names).toContain('search');
    expect(names).toContain('paper');
    expect(names).toContain('note');
    expect(names).toContain('export');
    expect(names).toContain('stop');
    expect(names).toContain('pause');
    expect(names).toContain('resume');
    expect(names).toContain('status');
    expect(names).toContain('help');
  });

  it('matches /chat with an argument', () => {
    const result = matchSlashCommand('/chat hello world');
    expect(result?.command.name).toBe('chat');
    expect(result?.arg).toBe('hello world');
  });

  it('matches /goal with an argument', () => {
    const result = matchSlashCommand('/goal 分析论文');
    expect(result?.command.name).toBe('goal');
    expect(result?.arg).toBe('分析论文');
  });

  it('returns null for non-slash input', () => {
    expect(matchSlashCommand('hello world')).toBeNull();
  });

  it('returns null for unknown command', () => {
    expect(matchSlashCommand('/xyz')).toBeNull();
  });

  it('requires arg for commands that need it', () => {
    const result = matchSlashCommand('/goal');
    expect(result).toBeNull();
  });

  it('allows no-arg commands like /help', () => {
    const result = matchSlashCommand('/help');
    expect(result?.command.name).toBe('help');
    expect(result?.arg).toBe('');
  });

  it('filters commands by prefix', () => {
    const results = filterSlashCommands('st');
    expect(results.map((c) => c.name)).toEqual(expect.arrayContaining(['stop', 'status']));
  });
});
