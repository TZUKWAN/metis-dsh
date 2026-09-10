/**
 * Capability Manifest — the protocol for Metis's seven native research capabilities.
 *
 * (METIS-202) A Capability is a versioned, sourced, permission-scoped unit of research
 * ability. The manifest is the single schema any capability pack must satisfy to be
 * registered. Invalid manifests (missing license, ambiguous permissions, unknown stage)
 * are rejected at registration time so they can never reach the model.
 *
 * Design rules (from ADR-001 / task list):
 *   - Only seven first-class capabilities exist (METIS-203). The schema does NOT enforce
 *     the count of seven here (that is a registry-level invariant, METIS-203); it enforces
 *     per-manifest correctness.
 *   - Every capability MUST declare a `source` with a verifiable license. No license =>
 *     registration rejected.
 *   - Permissions are an explicit, closed set (METIS-207 enforces them at call time).
 */

import { z } from 'zod';

// ─── Primitives ───────────────────────────────────────────────

export const DISCIPLINES = [
  'literature', 'history', 'philosophy', 'sociology',
  'political_science', 'public_administration', 'communication',
  'education', 'law', 'economics', 'interdisciplinary',
] as const;
export const DisciplineSchema = z.enum(DISCIPLINES);

export const RESEARCH_STAGES = [
  'design', 'source_research', 'literature_review',
  'qualitative_analysis', 'quantitative_analysis',
  'argumentation_writing', 'verification_delivery',
] as const;
export const ResearchStageSchema = z.enum(RESEARCH_STAGES);

export const CAPABILITY_PERMISSIONS = [
  'read_source',        // read materials from the library
  'search_web',         // perform network retrieval (OpenAlex/Crossref/arXiv/...)
  'write_file',         // write artifacts / notes
  'execute_code',       // run sandboxed code (stats/Python runtime)
  'call_external',      // invoke an external program (LaTeX/MCP connector)
  'access_sensitive',   // touch user-marked sensitive data (e.g. de-identified interviews)
] as const;
export const CapabilityPermissionSchema = z.enum(CAPABILITY_PERMISSIONS);

// ─── Source + License (must be verifiable) ────────────────────

export const LicenseSchema = z.enum([
  'MIT',
  'Apache-2.0',
  'GPL-3.0-or-later',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'proprietary',
  'internal', // authored inside Metis itself
]);

/**
 * Provenance for a capability's content. `commit` or `version` pins an exact snapshot so
 * the license evidence is reproducible. `registerEntry` links back to the third-party
 * capability register (METIS-201) for audit.
 */
export const CapabilitySourceSchema = z.object({
  origin: z.enum(['internal', 'third_party']),
  // For third_party: the GitHub repo (org/name). For internal: 'metis'.
  repository: z.string().min(1),
  // Pin: either a git commit sha or a version tag. Required so license evidence is fixed.
  commit: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  license: LicenseSchema,
  // Human-readable evidence of the license claim (e.g. "LICENSE file present, MIT badge").
  licenseEvidence: z.string().min(1),
  // Reference into docs/THIRD_PARTY_CAPABILITY_REGISTER.md (METIS-201 entry id).
  registerEntry: z.string().min(1).optional(),
}).superRefine((val, ctx) => {
  if (val.origin === 'third_party') {
    if (!val.commit && !val.version) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'third_party capability source must pin a commit or version for reproducible license evidence',
        path: ['commit'],
      });
    }
    if (val.license === 'internal') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'third_party source cannot declare license "internal"',
        path: ['license'],
      });
    }
  }
  if (val.origin === 'internal' && val.license !== 'internal') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'internal source should declare license "internal"',
      path: ['license'],
    });
  }
});

// ─── Visualization declaration ────────────────────────────────

export const VisualizationKindSchema = z.enum([
  'none', 'chart', 'table', 'network', 'timeline', 'map', 'manuscript', 'pdf_view',
]);

// ─── The Capability Manifest ──────────────────────────────────

export const CapabilityManifestSchema = z.object({
  // Globally unique, stable id (kebab-case).
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'id must be kebab-case (lowercase, digits, hyphens)'),
  // Display name (user-facing terms per METIS-107 dictionary; not a technical term).
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver x.y.z'),
  description: z.string().min(1),

  // Which of the seven research stages this capability serves (1..many).
  stages: z.array(ResearchStageSchema).min(1),
  // Which disciplines it is primarily authored for.
  disciplines: z.array(DisciplineSchema).min(1),

  // Input/output contract.
  inputs: z.array(z.object({
    name: z.string().min(1),
    type: z.string().min(1),
    required: z.boolean(),
    description: z.string().min(1),
  })).default([]),
  outputs: z.array(z.object({
    name: z.string().min(1),
    type: z.string().min(1),
    description: z.string().min(1),
  })).min(1, 'a capability must declare at least one output'),

  // Closed-set permissions (METIS-207). Must be non-empty: a capability with no
  // permissions can do nothing and is therefore malformed.
  permissions: z.array(CapabilityPermissionSchema).min(1),

  // Runtime dependencies (e.g. a Python runtime for GABRIEL/StatsPAI).
  dependencies: z.array(z.object({
    name: z.string().min(1),
    kind: z.enum(['runtime', 'binary', 'package']),
    required: z.boolean(),
  })).default([]),

  // Artifacts this capability produces (maps to METIS-601 Artifact types).
  producesArtifacts: z.array(z.string().min(1)).default([]),

  // Visualization hint for the viewer registry (METIS-606).
  visualization: VisualizationKindSchema.default('none'),

  // Provenance — REQUIRED and must be verifiable.
  source: CapabilitySourceSchema,

  // Evaluation suite reference (METIS-210).
  evalSuite: z.string().min(1).optional(),

  // Known limitations (surfaced to user honestly, METIS-107).
  limitations: z.array(z.string().min(1)).default([]),
});

// ─── Inferred TS types ────────────────────────────────────────

export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;
export type CapabilitySource = z.infer<typeof CapabilitySourceSchema>;
export type CapabilityPermission = z.infer<typeof CapabilityPermissionSchema>;
export type ResearchStage = z.infer<typeof ResearchStageSchema>;
export type Discipline = z.infer<typeof DisciplineSchema>;
export type VisualizationKind = z.infer<typeof VisualizationKindSchema>;

// ─── Parse helper (the registration gate) ─────────────────────

/**
 * Validate a manifest. Returns a discriminated union so callers can branch on success
 * without throwing. This is the gate every capability registration must pass (METIS-202
 * completion: "invalid, missing license, or ambiguous-permission capabilities cannot
 * register").
 */
export function parseCapabilityManifest(
  unknown: unknown,
):
  | { success: true; manifest: CapabilityManifest }
  | { success: false; errors: string[] } {
  const result = CapabilityManifestSchema.safeParse(unknown);
  if (result.success) {
    return { success: true, manifest: result.data };
  }
  const errors = result.error.issues.map(
    (iss) => `${iss.path.join('.')}: ${iss.message}`,
  );
  return { success: false, errors };
}
