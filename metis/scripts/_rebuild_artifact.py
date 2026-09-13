# Rebuild the damaged tool region in plugins/artifact/src/index.ts.

path = 'plugins/artifact/src/index.ts'
src = open(path, encoding='utf-8', newline='').read()

start_marker = "    ctx.tools.register(defineTool({\n      name: 'artifact_version',"
end_marker = "        }\n      },\n    }))\n  }\n}"

start = src.index(start_marker)
end = src.index(end_marker, start) + len(end_marker)

version_and_update_and_finalize = """    ctx.tools.register(defineTool({
      name: 'artifact_version',
      description: '为当前项目内 Artifact 追加一个新版本。路径必须在当前 DSH Workspace 内且文件已存在；历史版本不可覆盖。',
      parameters: {
        id: { type: 'string', description: 'Artifact id', required: true },
        path: { type: 'string', description: '当前 DSH Workspace 内新文件的相对路径', required: true },
        note: { type: 'string', description: '版本说明' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { ok: { type: 'boolean' }, artifact: { type: 'json' }, error: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        const project = await this.research.requireCurrentProject(exec.agent)
        const data = await this.dataStore()
        const existing = data.getArtifact(args.id)
        if (!existing || existing.projectId !== project.id) {
          return { ok: false as const, artifact: null, error: `当前项目中不存在 Artifact: ${args.id}` }
        }
        const workspace = resolveWorkspaceScope(ctx, exec.agent)
        const file = workspaceRelativePath(workspace.path, args.path)
        if (!existsSync(file.absolutePath)) return { ok: false as const, artifact: null, error: `当前 DSH Workspace 中不存在文件: ${file.relativePath}` }
        const artifact = data.addArtifactVersion(args.id, file.relativePath, args.note, {
          contentHash: createHash('sha256').update(readFileSync(file.absolutePath)).digest('hex'),
          createdBy: 'model',
        })
        if (!artifact) return { ok: false as const, artifact: null, error: `Artifact 不存在: ${args.id}` }
        return { ok: true as const, artifact: toJson(artifact), error: '' as string }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'artifact_update_metadata',
      description: '更新当前项目内 Artifact 的标题、状态或 Evidence 关联，不生成文件版本。',
      parameters: {
        id: { type: 'string', description: 'Artifact id', required: true },
        title: { type: 'string', description: '新标题' },
        status: { type: 'string', description: 'draft/review/final' },
        evidenceIds: { type: 'json', description: '替换 Evidence 关联的 id 数组' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { ok: { type: 'boolean' }, artifact: { type: 'json' }, error: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        if (args.evidenceIds !== undefined && (!Array.isArray(args.evidenceIds) || !args.evidenceIds.every((value: unknown) => typeof value === 'string'))) {
          return { ok: false as const, artifact: null, error: 'evidenceIds 必须是 Evidence id 字符串数组。' }
        }
        const project = await this.research.requireCurrentProject(exec.agent)
        const data = await this.dataStore()
        const existing = data.getArtifact(args.id)
        if (!existing || existing.projectId !== project.id) return { ok: false as const, artifact: null, error: `当前项目中不存在 Artifact: ${args.id}` }
        const status = args.status === undefined ? undefined : configuredStatus(args.status)
        if (args.status !== undefined && !status) return { ok: false as const, artifact: null, error: `未知 Artifact 状态: ${args.status}` }
        const artifact = data.updateArtifact(args.id, {
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(status ? { status } : {}),
          ...(args.evidenceIds === undefined ? {} : { evidenceIds: args.evidenceIds }),
        })
        if (!artifact) return { ok: false as const, artifact: null, error: `Artifact 不存在: ${args.id}` }
        return { ok: true as const, artifact: toJson(artifact), error: '' as string }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'artifact_finalize',
      description: '把当前项目内 Artifact 定稿（status=final 并记录 finalized_at）。定稿前执行 Research Quality Guard：空文档/未解决占位符为 critical（默认拒绝定稿，force=true 带 warnings 强制定稿）；未核验 DOI 与缺失结构节为 warnings。',
      parameters: {
        id: { type: 'string', description: 'Artifact id', required: true },
        force: { type: 'boolean', description: '存在 critical 问题时强制定稿（warnings 将随记录返回）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, artifact: { type: 'json' }, error: { type: 'string' }, warnings: { type: 'json' }, researchQuality: { type: 'json' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        const project = await this.research.requireCurrentProject(exec.agent)
        const data = await this.dataStore()
        const existing = data.getArtifact(args.id)
        if (!existing || existing.projectId !== project.id) {
          return { ok: false as const, artifact: null, warnings: [], researchQuality: null, error: `当前项目中不存在 Artifact: ${args.id}` }
        }
        const workspace = resolveWorkspaceScope(ctx, exec.agent)
        const current = existing.versions.at(-1)
        const absolute = resolve(workspace.path, current?.workspacePath ?? existing.workspacePath)
        const quality = existsSync(absolute)
          ? buildResearchQualityReport({
              text: readFileSync(absolute, 'utf8'),
              libraryDois: new Set(data.listLiterature(project.id).flatMap((record) => (record.doi ? [record.doi] : []))),
              expectStructure: existing.type !== 'dataset',
            })
          : null
        const critical = quality ? criticalIssues(quality) : []
        if (critical.length > 0 && args.force !== true) {
          return {
            ok: false as const,
            artifact: null,
            warnings: toJson(quality?.issues ?? []),
            researchQuality: toJson(quality),
            error: `存在 ${critical.length} 个 critical 质量问题（空文档/未解决占位符），解决后定稿，或以 force=true 强制定稿（将带 warnings）。`,
          }
        }
        const artifact = data.setArtifactFinalized(args.id)
        if (!artifact) {
          return { ok: false as const, artifact: null, warnings: [], researchQuality: null, error: `Artifact 不存在: ${args.id}` }
        }
        return {
          ok: true as const,
          artifact: toJson(artifact),
          warnings: toJson(quality?.issues ?? []),
          researchQuality: toJson(quality),
          error: '' as string,
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'artifact_evidence_check',
      description: '报告 Artifact 的 Claim 证据覆盖率（总数/各状态/supported/contradicted/无证据数/覆盖率）。第一版启发式统计，诚实标注。',
      parameters: { artifactId: { type: 'string', description: 'Artifact id', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { report: { type: 'json' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        const project = await this.research.requireCurrentProject(exec.agent)
        const data = await this.dataStore()
        const existing = data.getArtifact(args.artifactId)
        if (!existing || existing.projectId !== project.id) throw new Error(`当前项目中不存在 Artifact: ${args.artifactId}`)
        return { report: toJson(data.artifactEvidenceCheck(args.artifactId)) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'artifact_compare',
      description: '对比同一 Artifact 的两个版本：版本元数据、内容哈希与逐行差异（LCS）。文件必须在当前 DSH Workspace 内可读。',
      parameters: {
        id: { type: 'string', description: 'Artifact id', required: true },
        fromVersion: { type: 'number', description: '起始版本号', required: true },
        toVersion: { type: 'number', description: '目标版本号', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, diff: { type: 'json' }, error: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        const project = await this.research.requireCurrentProject(exec.agent)
        const data = await this.dataStore()
        const existing = data.getArtifact(args.id)
        if (!existing || existing.projectId !== project.id) return { ok: false, diff: null, error: `当前项目中不存在 Artifact: ${args.id}` }
        const from = existing.versions.find((entry) => entry.version === args.fromVersion)
        const to = existing.versions.find((entry) => entry.version === args.toVersion)
        if (!from || !to) return { ok: false, diff: null, error: '版本不存在（使用 artifact_get 查看版本历史）。' }
        const workspace = resolveWorkspaceScope(ctx, exec.agent)
        const readLines = (relativePath: string): string[] => {
          const file = workspaceRelativePath(workspace.path, relativePath)
          if (!existsSync(file.absolutePath)) throw new Error(`文件不在当前 Workspace 或已丢失: ${relativePath}`)
          return readFileSync(file.absolutePath, 'utf8').split(/?
/)
        }
        const a = readLines(from.workspacePath)
        const b = readLines(to.workspacePath)
        const diffLines = lineDiff(a, b)
        return {
          ok: true,
          diff: toJson({
            artifactId: existing.id,
            from: { version: from.version, workspacePath: from.workspacePath, contentHash: from.contentHash ?? null },
            to: { version: to.version, workspacePath: to.workspacePath, contentHash: to.contentHash ?? null },
            contentHashMatchesFile: {
              from: from.contentHash ? createHash('sha256').update(readFileSync(resolve(workspace.path, from.workspacePath))).digest('hex') === from.contentHash : null,
              to: to.contentHash ? createHash('sha256').update(readFileSync(resolve(workspace.path, to.workspacePath))).digest('hex') === to.contentHash : null,
            },
            added: diffLines.filter((line) => line.kind === 'added').length,
            removed: diffLines.filter((line) => line.kind === 'removed').length,
            unchanged: diffLines.filter((line) => line.kind === 'unchanged').length,
            lines: diffLines,
          }),
          error: '',
        }
      },
    }))
  }
}
(value: string | undefined): ArtifactStatus | undefined {
  return value === 'draft' || value === 'review' || value === 'final' ? value : undefined
}"""

src = src[:start] + version_and_update_and_finalize + src[end:]
open(path, 'w', encoding='utf-8', newline='\n').write(src)
print('artifact tool region rebuilt')
