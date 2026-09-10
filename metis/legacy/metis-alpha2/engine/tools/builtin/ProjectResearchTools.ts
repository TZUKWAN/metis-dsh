/** Project-scoped research source tools backed by the canonical repository. */

import type { ToolSpec } from '../../core/types.js';
import type { ResearchRepository } from '../../persistence/ResearchRepository.js';
import type { ToolHandler } from '../ToolDispatcher.js';

export const LIST_PROJECT_SOURCES_TOOL: ToolSpec = {
  name: 'list_sources',
  description: 'List and search the active METIS research project sources and anchored evidence. Returns canonical source ids, bibliographic metadata, local file paths or URLs, and evidence snippets for grounded analysis.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional title, author, identifier, tag, or evidence text filter.' },
      limit: { type: 'number', description: 'Maximum source records to return (1-50, default 20).' },
    },
  },
};

export function createProjectResearchToolHandlers(
  repository?: ResearchRepository,
): Map<string, ToolHandler> {
  if (!repository) return new Map();
  const handler: ToolHandler = async (args, context) => {
    const projectId = context.projectId;
    if (!projectId) throw new Error('list_sources requires an active research project');
    const project = repository.getProject(projectId);
    if (!project) throw new Error(`Research project '${projectId}' was not found`);

    const query = typeof args.query === 'string' ? args.query.trim().toLocaleLowerCase() : '';
    const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.trunc(args.limit)
      : 20;
    const limit = Math.max(1, Math.min(50, requestedLimit));
    const sources = repository.listSources(projectId).flatMap((source) => {
      const evidence = repository.listEvidence(projectId, source.id)
        .map((item) => ({
          id: item.id,
          anchorType: item.anchorType,
          pageNumber: item.pageNumber,
          anchorStart: item.anchorStart,
          anchorEnd: item.anchorEnd,
          snippet: item.snippet,
          confidence: item.confidence,
        }));
      const searchable = [
        source.title,
        ...source.authors,
        source.venue,
        source.identifier,
        ...source.tags,
        ...evidence.map((item) => item.snippet),
      ].join('\n').toLocaleLowerCase();
      if (query && !searchable.includes(query)) return [];
      return [{
        id: source.id,
        kind: source.kind,
        title: source.title,
        authors: source.authors,
        year: source.year,
        venue: source.venue,
        identifier: source.identifier,
        identifierType: source.identifierType,
        filePath: source.filePath,
        externalUrl: source.externalUrl,
        tags: source.tags,
        sourceVersionHash: source.sourceVersionHash,
        evidence,
      }];
    }).slice(0, limit);

    return JSON.stringify({
      project: {
        id: project.id,
        title: project.title,
        researchQuestion: project.researchQuestion,
        methodology: project.methodology,
      },
      query: query || null,
      returned: sources.length,
      totalProjectSources: repository.listSources(projectId).length,
      sources,
    });
  };
  return new Map([['list_sources', handler]]);
}
