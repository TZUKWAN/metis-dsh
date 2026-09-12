# One-shot patch: v2 data APIs (evidence coverage, funding, submission, artifact hardening).

path = 'shared/data/src/index.ts'
src = open(path, encoding='utf-8').read()

old = """  addArtifactVersion(id: string, workspacePath: string, note?: string): ArtifactRecord | null {
    const current = this.getArtifact(id)
    if (!current) return null
    const version = current.version + 1
    const now = Date.now()
    this.transaction(() => {
      this.requireDb().prepare(`
        INSERT INTO artifact_versions (artifact_id, version, workspace_path, note, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, version, workspacePath, nullableText(note), now)
      this.requireDb().prepare(`
        UPDATE artifacts SET workspace_path = ?, version = ?, updated_at = ? WHERE id = ?
      `).run(workspacePath, version, now, id)
    })
    return this.getArtifact(id)
  }"""
new = """  addArtifactVersion(
    id: string,
    workspacePath: string,
    note?: string,
    options: { contentHash?: string; createdBy?: string } = {},
  ): ArtifactRecord | null {
    const current = this.getArtifact(id)
    if (!current) return null
    const version = current.version + 1
    const now = Date.now()
    this.transaction(() => {
      this.requireDb().prepare(`
        INSERT INTO artifact_versions (artifact_id, version, workspace_path, note, created_at, content_hash, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, version, workspacePath, nullableText(note), now, nullableText(options.contentHash), nullableText(options.createdBy))
      this.requireDb().prepare(`
        UPDATE artifacts SET workspace_path = ?, version = ?, updated_at = ? WHERE id = ?
      `).run(workspacePath, version, now, id)
    })
    return this.getArtifact(id)
  }

  setArtifactFinalized(id: string): ArtifactRecord | null {
    const current = this.getArtifact(id)
    if (!current) return null
    this.requireDb().prepare(
      "UPDATE artifacts SET status = 'final', finalized_at = ?, updated_at = ? WHERE id = ?",
    ).run(Date.now(), Date.now(), id)
    return this.getArtifact(id)
  }

  /**
   * Evidence coverage for one artifact's claims (attached via
   * evidence_claims.artifact_id). First-version heuristic, honestly labeled.
   */
  artifactEvidenceCheck(artifactId: string): {
    artifactId: string
    totalClaims: number
    byState: Record<string, number>
    supportedClaims: number
    contradictedClaims: number
    claimsWithoutEvidence: number
    unverifiedClaims: number
    coverageRatio: number
    claims: Array<EvidenceClaimRecord & { evidenceCount: number }>
  } {
    const artifact = this.getArtifact(artifactId)
    if (!artifact) throw new Error(`unknown artifact: ${artifactId}`)
    const claims = this.listClaims({ artifactId })
    const counts = new Map<string, number>()
    for (const row of this.requireDb().prepare(
      'SELECT claim_id, COUNT(*) AS n FROM claim_evidence_links GROUP BY claim_id',
    ).all() as Array<Record<string, unknown>>) {
      counts.set(String(row['claim_id']), Number(row['n']))
    }
    const byState: Record<string, number> = {}
    let supported = 0
    let contradicted = 0
    let withoutEvidence = 0
    let unverified = 0
    const detailed = claims.map((claim) => {
      const evidenceCount = counts.get(claim.id) ?? 0
      byState[claim.verificationState] = (byState[claim.verificationState] ?? 0) + 1
      if (evidenceCount > 0) {
        const relations = this.requireDb().prepare(
          'SELECT relation FROM claim_evidence_links WHERE claim_id = ?',
        ).all(claim.id) as Array<Record<string, unknown>>
        if (relations.some((row) => row['relation'] === 'supports')) supported += 1
        if (relations.some((row) => row['relation'] === 'contradicts')) contradicted += 1
      } else {
        withoutEvidence += 1
      }
      if (claim.verificationState === 'unverified') unverified += 1
      return { ...claim, evidenceCount }
    })
    return {
      artifactId,
      totalClaims: claims.length,
      byState,
      supportedClaims: supported,
      contradictedClaims: contradicted,
      claimsWithoutEvidence: withoutEvidence,
      unverifiedClaims: unverified,
      coverageRatio: claims.length === 0 ? 0 : supported / claims.length,
      claims: detailed,
    }
  }

  // ── Funding persistence (v2) ────────────────────────────────────────────

  saveFundingTemplate(input: {
    templateId: string
    projectId?: string | null
    version: number
    template: JsonValue
  }): FundingTemplateRecord {
    if (!/^[A-Za-z0-9:_-]+$/.test(input.templateId)) throw new Error(`invalid templateId: ${input.templateId}`)
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error('template version must be a positive integer')
    const now = Date.now()
    const projectId = nullableText(input.projectId ?? undefined)
    if (projectId && !this.getProject(projectId)) throw new Error(`cannot attach template to unknown project: ${projectId}`)
    this.transaction(() => {
      this.requireDb().prepare(`
        INSERT INTO funding_templates (id, project_id, template_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          template_json = excluded.template_json,
          updated_at = excluded.updated_at
      `).run(input.templateId, projectId, JSON.stringify(input.template), now, now)
      this.requireDb().prepare(`
        INSERT INTO funding_template_versions (template_id, version, template_json, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(template_id, version) DO UPDATE SET template_json = excluded.template_json
      `).run(input.templateId, input.version, JSON.stringify(input.template), now)
    })
    return this.getFundingTemplate(input.templateId) ?? fail('funding template was not readable after save')
  }

  getFundingTemplate(templateId: string): FundingTemplateRecord | null {
    const row = this.requireDb().prepare('SELECT * FROM funding_templates WHERE id = ?').get(templateId)
    if (!row) return null
    const record = row as Record<string, unknown>
    const versionRow = this.requireDb().prepare(
      'SELECT MAX(version) AS v FROM funding_template_versions WHERE template_id = ?',
    ).get(templateId) as Record<string, unknown>
    return {
      templateId: requiredString(record['id'], 'funding template id'),
      projectId: typeof record['project_id'] === 'string' ? record['project_id'] : null,
      version: typeof versionRow['v'] === 'number' ? versionRow['v'] : 0,
      template: JSON.parse(requiredString(record['template_json'], 'funding template_json')) as JsonValue,
      createdAt: asTimestamp(record['created_at'], 'funding template created_at'),
      updatedAt: asTimestamp(record['updated_at'], 'funding template updated_at'),
    }
  }

  listFundingTemplates(projectId?: string): FundingTemplateRecord[] {
    const rows = projectId
      ? this.requireDb().prepare('SELECT id FROM funding_templates WHERE project_id = ? ORDER BY updated_at DESC').all(projectId)
      : this.requireDb().prepare('SELECT id FROM funding_templates ORDER BY updated_at DESC').all()
    return rows
      .map((row) => this.getFundingTemplate(String((row as Record<string, unknown>)['id'])))
      .filter((value): value is FundingTemplateRecord => value !== null)
  }

  saveFundingSectionDraft(input: {
    projectId: string
    templateId: string
    sectionId: string
    draftText: string
    usedEvidenceIds: readonly string[]
  }): FundingSectionDraftRecord {
    if (!this.getProject(input.projectId)) throw new Error(`cannot attach draft to unknown project: ${input.projectId}`)
    const draftText = input.draftText.trim()
    if (!draftText) throw new Error('draft text cannot be empty')
    for (const evidenceId of input.usedEvidenceIds) {
      if (!this.getEvidence(evidenceId)) throw new Error(`draft references unknown evidence: ${evidenceId}`)
    }
    const now = Date.now()
    const id = `draft-${randomUUID()}`
    const usedEvidenceIds = [...new Set(input.usedEvidenceIds)]
    this.requireDb().prepare(`
      INSERT INTO funding_section_drafts (id, project_id, template_id, section_id, draft_text, used_evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.projectId, input.templateId, input.sectionId, draftText, JSON.stringify(usedEvidenceIds), now)
    return {
      id,
      projectId: input.projectId,
      templateId: input.templateId,
      sectionId: input.sectionId,
      draftText,
      usedEvidenceIds,
      createdAt: now,
    }
  }

  listFundingSectionDrafts(projectId: string, templateId?: string): FundingSectionDraftRecord[] {
    const rows = templateId
      ? this.requireDb().prepare('SELECT * FROM funding_section_drafts WHERE project_id = ? AND template_id = ? ORDER BY created_at ASC').all(projectId, templateId)
      : this.requireDb().prepare('SELECT * FROM funding_section_drafts WHERE project_id = ? ORDER BY created_at ASC').all(projectId)
    return rows.map((row) => {
      const record = row as Record<string, unknown>
      return {
        id: requiredString(record['id'], 'draft id'),
        projectId: requiredString(record['project_id'], 'draft project_id'),
        templateId: requiredString(record['template_id'], 'draft template_id'),
        sectionId: requiredString(record['section_id'], 'draft section_id'),
        draftText: requiredString(record['draft_text'], 'draft text'),
        usedEvidenceIds: (JSON.parse(requiredString(record['used_evidence_json'], 'draft used_evidence_json')) as unknown[])
          .filter((value): value is string => typeof value === 'string'),
        createdAt: asTimestamp(record['created_at'], 'draft created_at'),
      }
    })
  }

  // ── Submission persistence (v2) ─────────────────────────────────────────

  upsertJournalRecord(input: {
    journalId?: string
    source: string
    sourceId?: string
    journal: JsonValue
    verificationState?: EvidenceVerificationState
  }): string {
    const now = Date.now()
    const id = input.journalId ?? `jr-${randomUUID()}`
    this.requireDb().prepare(`
      INSERT INTO journal_records (id, source, source_id, journal_json, verification_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        journal_json = excluded.journal_json,
        verification_state = excluded.verification_state,
        updated_at = excluded.updated_at
    `).run(
      id,
      requiredString(input.source, 'journal source'),
      nullableText(input.sourceId),
      JSON.stringify(input.journal),
      input.verificationState ?? 'unverified',
      now,
      now,
    )
    return id
  }

  getJournalRecord(id: string): {
    id: string
    source: string
    sourceId?: string
    journal: JsonValue
    verificationState: EvidenceVerificationState
    createdAt: number
    updatedAt: number
  } | null {
    const row = this.requireDb().prepare('SELECT * FROM journal_records WHERE id = ?').get(id)
    if (!row) return null
    const record = row as Record<string, unknown>
    const sourceId = optionalString(record['source_id'])
    return {
      id: requiredString(record['id'], 'journal id'),
      source: requiredString(record['source'], 'journal source'),
      ...(sourceId ? { sourceId } : {}),
      journal: JSON.parse(requiredString(record['journal_json'], 'journal_json')) as JsonValue,
      verificationState: requiredString(record['verification_state'], 'journal verification_state') as EvidenceVerificationState,
      createdAt: asTimestamp(record['created_at'], 'journal created_at'),
      updatedAt: asTimestamp(record['updated_at'], 'journal updated_at'),
    }
  }

  setJournalRequirements(journalId: string, requirements: JsonValue, verificationState: EvidenceVerificationState): string {
    if (!this.getJournalRecord(journalId)) throw new Error(`cannot set requirements for unknown journal: ${journalId}`)
    const now = Date.now()
    const id = `jreq-${randomUUID()}`
    this.requireDb().prepare(`
      INSERT INTO journal_requirements (id, journal_id, requirements_json, verification_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, journalId, JSON.stringify(requirements), verificationState, now, now)
    return id
  }

  getJournalRequirements(journalId: string): JournalRequirementRecord[] {
    return this.requireDb().prepare(
      'SELECT * FROM journal_requirements WHERE journal_id = ? ORDER BY created_at DESC',
    ).all(journalId).map((row) => {
      const record = row as Record<string, unknown>
      return {
        id: requiredString(record['id'], 'journal requirement id'),
        journalId: requiredString(record['journal_id'], 'journal requirement journal_id'),
        requirements: JSON.parse(requiredString(record['requirements_json'], 'requirements_json')) as JsonValue,
        verificationState: requiredString(record['verification_state'], 'requirements verification_state') as EvidenceVerificationState,
        updatedAt: asTimestamp(record['updated_at'], 'requirements updated_at'),
      }
    })
  }

  createSubmissionCase(input: {
    projectId?: string | null
    artifactId?: string | null
    journalId?: string | null
    notes?: string
  }): SubmissionCaseRecord {
    if (input.projectId && !this.getProject(input.projectId)) throw new Error(`unknown project: ${input.projectId}`)
    if (input.artifactId && !this.getArtifact(input.artifactId)) throw new Error(`unknown artifact: ${input.artifactId}`)
    if (input.journalId && !this.getJournalRecord(input.journalId)) throw new Error(`unknown journal: ${input.journalId}`)
    const now = Date.now()
    const id = `case-${randomUUID()}`
    this.requireDb().prepare(`
      INSERT INTO submission_cases (id, project_id, artifact_id, journal_id, state_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.projectId ?? null, input.artifactId ?? null, input.journalId ?? null,
      JSON.stringify({ status: 'researching', notes: input.notes ?? '' }), now, now)
    return this.getSubmissionCase(id) ?? fail('submission case was not readable after insert')
  }

  getSubmissionCase(id: string): SubmissionCaseRecord | null {
    const row = this.requireDb().prepare('SELECT * FROM submission_cases WHERE id = ?').get(id)
    if (!row) return null
    const record = row as Record<string, unknown>
    const state = JSON.parse(requiredString(record['state_json'], 'case state_json')) as { status?: string; notes?: string }
    return submissionCaseFromRow(record, state)
  }

  listSubmissionCases(projectId?: string): SubmissionCaseRecord[] {
    const rows = projectId
      ? this.requireDb().prepare('SELECT * FROM submission_cases WHERE project_id = ? ORDER BY updated_at DESC').all(projectId)
      : this.requireDb().prepare('SELECT * FROM submission_cases ORDER BY updated_at DESC').all()
    return rows.map((row) => {
      const record = row as Record<string, unknown>
      const state = JSON.parse(requiredString(record['state_json'], 'case state_json')) as { status?: string; notes?: string }
      return submissionCaseFromRow(record, state)
    })
  }

  updateSubmissionCase(id: string, patch: {
    status?: SubmissionCaseStatus
    notes?: string
    journalId?: string | null
    artifactId?: string | null
  }): SubmissionCaseRecord | null {
    const current = this.getSubmissionCase(id)
    if (!current) return null
    const status = patch.status ?? current.status
    if (!(SUBMISSION_CASE_STATUSES as readonly string[]).includes(status)) throw new Error(`unknown submission status: ${status}`)
    if (patch.journalId && !this.getJournalRecord(patch.journalId)) throw new Error(`unknown journal: ${patch.journalId}`)
    if (patch.artifactId && !this.getArtifact(patch.artifactId)) throw new Error(`unknown artifact: ${patch.artifactId}`)
    this.requireDb().prepare(`
      UPDATE submission_cases SET
        artifact_id = ?, journal_id = ?, state_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.artifactId === undefined ? current.artifactId : patch.artifactId,
      patch.journalId === undefined ? current.journalId : patch.journalId,
      JSON.stringify({
        status,
        notes: patch.notes === undefined ? current.notes ?? '' : patch.notes,
      }),
      Date.now(),
      id,
    )
    return this.getSubmissionCase(id)
  }

  addSubmissionCheck(caseId: string, check: JsonValue): string {
    if (!this.getSubmissionCase(caseId)) throw new Error(`unknown submission case: ${caseId}`)
    const id = `chk-${randomUUID()}`
    this.requireDb().prepare(
      'INSERT INTO submission_checks (id, case_id, check_json, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, caseId, JSON.stringify(check), Date.now())
    return id
  }

  recordArtifactJournalMatch(input: { artifactId: string; journalId: string; score?: number }): void {
    if (!this.getArtifact(input.artifactId)) throw new Error(`unknown artifact: ${input.artifactId}`)
    if (!this.getJournalRecord(input.journalId)) throw new Error(`unknown journal: ${input.journalId}`)
    this.requireDb().prepare(`
      INSERT INTO artifact_journal_matches (artifact_id, journal_id, score, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(artifact_id, journal_id) DO UPDATE SET score = excluded.score, created_at = excluded.created_at
    `).run(input.artifactId, input.journalId, input.score ?? null, Date.now())
  }

  /**
   * First-version gap check: journal requirement sets' verification facts
   * versus the artifact record. Reports unverified/conflicting requirement
   * sets and absent artifact metadata keys; never invents conformance.
   */
  submissionGapCheck(caseId: string): {
    caseRecord: SubmissionCaseRecord
    requirementSets: Array<JournalRequirementRecord>
    artifact: ArtifactRecord | null
    unverifiedRequirementSets: number
    conflictingRequirementSets: number
    artifactMissingKeys: string[]
  } {
    const caseRecord = this.getSubmissionCase(caseId)
    if (!caseRecord) throw new Error(`unknown submission case: ${caseId}`)
    const requirementSets = caseRecord.journalId ? this.getJournalRequirements(caseRecord.journalId) : []
    const artifact = caseRecord.artifactId ? this.getArtifact(caseRecord.artifactId) : null
    const requirementKeys = new Set<string>()
    for (const set of requirementSets) {
      const value = set.requirements
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            const key = (item as Record<string, JsonValue>)['key']
            if (typeof key === 'string') requirementKeys.add(key)
          }
        }
      }
    }
    const artifactMissingKeys: string[] = []
    if (artifact) {
      for (const key of requirementKeys) {
        if ((artifact as unknown as Record<string, unknown>)[key] === undefined) artifactMissingKeys.push(key)
      }
    }
    return {
      caseRecord,
      requirementSets,
      artifact,
      unverifiedRequirementSets: requirementSets.filter((set) => set.verificationState === 'unverified').length,
      conflictingRequirementSets: requirementSets.filter((set) => set.verificationState === 'conflicting').length,
      artifactMissingKeys,
    }
  }"""
assert old in src, 'addArtifactVersion anchor missing'
src = src.replace(old, new, 1)

old_mapper = """function artifactVersionFromRow(row: unknown): ArtifactVersionRecord {
  const record = row as Record<string, unknown>
  return {
    artifactId: requiredString(record['artifact_id'], 'artifact version artifact_id'),
    version: asTimestamp(record['version'], 'artifact version number'),
    workspacePath: requiredString(record['workspace_path'], 'artifact version workspace_path'),
    ...(optionalString(record['note']) ? { note: optionalString(record['note']) } : {}),
    createdAt: asTimestamp(record['created_at'], 'artifact version created_at'),
  }
}"""
new_mapper = """function artifactVersionFromRow(row: unknown): ArtifactVersionRecord {
  const record = row as Record<string, unknown>
  const contentHash = optionalString(record['content_hash'])
  const createdBy = optionalString(record['created_by'])
  return {
    artifactId: requiredString(record['artifact_id'], 'artifact version artifact_id'),
    version: asTimestamp(record['version'], 'artifact version number'),
    workspacePath: requiredString(record['workspace_path'], 'artifact version workspace_path'),
    ...(contentHash ? { contentHash } : {}),
    ...(createdBy ? { createdBy } : {}),
    createdAt: asTimestamp(record['created_at'], 'artifact version created_at'),
    ...(optionalString(record['note']) ? { note: optionalString(record['note']) } : {}),
  }
}

function submissionCaseFromRow(record: Record<string, unknown>, state: { status?: string; notes?: string }): SubmissionCaseRecord {
  return {
    id: requiredString(record['id'], 'case id'),
    projectId: typeof record['project_id'] === 'string' ? record['project_id'] : null,
    artifactId: typeof record['artifact_id'] === 'string' ? record['artifact_id'] : null,
    journalId: typeof record['journal_id'] === 'string' ? record['journal_id'] : null,
    status: requiredString(state.status ?? 'researching', 'case status') as SubmissionCaseStatus,
    notes: typeof state.notes === 'string' ? state.notes : null,
    createdAt: asTimestamp(record['created_at'], 'case created_at'),
    updatedAt: asTimestamp(record['updated_at'], 'case updated_at'),
  }
}"""
assert old_mapper in src, 'version mapper anchor missing'
src = src.replace(old_mapper, new_mapper, 1)

old_rec = """  evidenceIds: string[]
  versions: ArtifactVersionRecord[]
}"""
new_rec = """  finalizedAt?: number
  evidenceIds: string[]
  versions: ArtifactVersionRecord[]
}"""
assert old_rec in src
src = src.replace(old_rec, new_rec, 1)

old_final = """      createdAt: asTimestamp(record['created_at'], 'artifact created_at'),
      updatedAt: asTimestamp(record['updated_at'], 'artifact updated_at'),
      evidenceIds,"""
new_final = """      ...(typeof record['finalized_at'] === 'number' ? { finalizedAt: record['finalized_at'] } : {}),
      createdAt: asTimestamp(record['created_at'], 'artifact created_at'),
      updatedAt: asTimestamp(record['updated_at'], 'artifact updated_at'),
      evidenceIds,"""
assert old_final in src
src = src.replace(old_final, new_final, 1)

open(path, 'w', encoding='utf-8', newline='\n').write(src)
print('v2 data APIs installed')
