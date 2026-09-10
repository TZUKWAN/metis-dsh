import type { PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';

export const SCENARIO_TAG_PREFIX = 'scenario:';

export function scenarioOnlyTag(scenarioId: string): string {
  return SCENARIO_TAG_PREFIX + scenarioId;
}

export function visibleInScenario(definition: PersonalizationDefinition, scenarioId: string): boolean {
  if (definition.kind !== 'agent') return true;
  return !definition.tags.some((tag) => tag.startsWith(SCENARIO_TAG_PREFIX) && tag !== SCENARIO_TAG_PREFIX + scenarioId);
}

export function currentTimestamp(): number {
  return Date.now();
}
