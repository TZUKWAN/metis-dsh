import type { PersonalizationRepository } from '../engine/personalization/PersonalizationRepository.js';
import type { PersonalizationBundleAssetBinding } from '../engine/runtime/PersonalizationBundleContract.js';
import type { PersonalizationDefinition } from '../engine/runtime/PersonalizationRuntimeContract.js';
import type {
  PersonalizationBundleDefinitionSink,
  PersonalizationBundleDefinitionTransaction,
} from './PersonalizationBundleService.js';

export class PersonalizationBundleRepositorySink implements PersonalizationBundleDefinitionSink {
  readonly #repository: PersonalizationRepository;

  constructor(repository: PersonalizationRepository) {
    this.#repository = repository;
  }

  get(id: string): PersonalizationDefinition | undefined {
    return this.#repository.get(id, true);
  }

  begin(): PersonalizationBundleDefinitionTransaction {
    const staged: Array<{
      definition: PersonalizationDefinition;
      assetBinding?: PersonalizationBundleAssetBinding;
    }> = [];
    let state: 'open' | 'committed' | 'rolled_back' = 'open';
    return {
      save: (definition, assetBinding) => {
        if (state !== 'open') throw new Error('Personalization bundle transaction is closed');
        if (staged.some((entry) => entry.definition.id === definition.id)) {
          throw new Error('Personalization bundle transaction contains duplicate IDs');
        }
        staged.push({ definition, ...(assetBinding ? { assetBinding } : {}) });
      },
      commit: () => {
        if (state !== 'open') throw new Error('Personalization bundle transaction is closed');
        this.#repository.importDefinitionsAtomically(staged);
        state = 'committed';
      },
      rollback: () => {
        if (state === 'committed') {
          throw new Error('Committed personalization definitions cannot be rolled back outside the database transaction');
        }
        staged.length = 0;
        state = 'rolled_back';
      },
    };
  }
}
