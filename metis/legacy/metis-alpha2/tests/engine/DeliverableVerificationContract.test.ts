import { describe, expect, it } from 'vitest';
import { ResearchArtifactVersionRequestSchema } from '../../engine/runtime/ResearchRuntimeContract.js';
import { bindDeliverableProfile } from '../../engine/writing/DeliverableProfile.js';

function verifiedRequest() {
  return {
    operation: 'save_version' as const,
    projectId: 'project-1',
    artifactId: 'artifact-1',
    expectedVersion: null,
    title: 'Verified manuscript',
    artifactType: 'manuscript' as const,
    reviewStatus: 'verified' as const,
    inputs: [{ kind: 'source' as const, id: 'source-1' }],
    capabilityId: 'writing',
    method: 'human-reviewed',
    citedSourceIds: ['source-1'],
    deliverableProfile: bindDeliverableProfile('sci'),
    deliverableContext: {
      templateId: 'sci-journal-author-guidelines', templateSourceId: 'template-source', contentFormat: 'markdown' as const,
      citationStyle: 'apa' as const, venueRuleSourceId: 'venue-rules', schoolRuleSourceId: null,
    },
    citationRequests: [{ sourceId: 'source-1', locator: 'p. 2' }],
    rendererKind: 'markdown' as const,
    contentRef: null,
    content: 'Grounded content [cite:source-1].',
  };
}

describe('verified deliverable runtime contract', () => {
  it('accepts a profile-bound request with locators but no renderer-authored truth', () => {
    expect(ResearchArtifactVersionRequestSchema.safeParse(verifiedRequest()).success).toBe(true);
  });

  it.each(['deliverableProfile', 'deliverableContext', 'citationRequests'] as const)('rejects verified artifacts missing %s', (key) => {
    const request = verifiedRequest();
    delete (request as unknown as Record<string, unknown>)[key];
    expect(ResearchArtifactVersionRequestSchema.safeParse(request).success).toBe(false);
  });

  it('keeps legacy drafts readable without new trust fields', () => {
    const request = verifiedRequest();
    const legacy = { ...request, reviewStatus: 'draft' as const } as Record<string, unknown>;
    delete legacy.deliverableProfile;
    delete legacy.deliverableContext;
    delete legacy.citationRequests;
    expect(ResearchArtifactVersionRequestSchema.safeParse(legacy).success).toBe(true);
  });
});
