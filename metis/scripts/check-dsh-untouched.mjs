#!/usr/bin/env node
/**
 * Enforce the DSH = upstream / METIS = metis/** boundary without requiring
 * an upstream Git object to be present in a fresh clone.
 *
 * The checked-in manifest records every upstream path, blob id and Git mode
 * from the declared official baseline. This checker verifies the current
 * index, working tree and untracked files against that immutable snapshot.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const metisRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(metisRoot, '..')
const manifestPath = path.join(metisRoot, 'UPSTREAM_MANIFEST.json')
const baselinePath = path.join(metisRoot, 'DSH_BASELINE.json')

const GIT_OUTPUT_MAX_BUFFER = 32 * 1024 * 1024

function git(args, allowFailure = false) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    })
  } catch (error) {
    if (allowFailure) return null
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
}

function isMetisPath(filePath) {
  return filePath === 'metis' || filePath.startsWith('metis/')
}

function readJson(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`missing ${label}: ${filePath}`)
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid ${label}: ${detail}`)
  }
}

function parseIndex() {
  const raw = execFileSync('git', ['ls-files', '--stage', '-z'], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  })
  const entries = new Map()
  for (const entry of raw.toString('utf8').split('\0')) {
    if (!entry) continue
    const separator = entry.indexOf('\t')
    if (separator < 0) throw new Error(`unexpected Git index entry: ${entry}`)
    const [mode, blob, stage] = entry.slice(0, separator).split(' ')
    const filePath = entry.slice(separator + 1)
    if (isMetisPath(filePath)) continue
    if (stage !== '0') throw new Error(`unmerged upstream path: ${filePath}`)
    entries.set(filePath, { mode, blob })
  }
  return entries
}

function parseManifest(manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error('UPSTREAM_MANIFEST.json must contain schemaVersion 1 and entries[]')
  }
  const entries = new Map()
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.mode !== 'string' || typeof entry.blob !== 'string') {
      throw new Error('UPSTREAM_MANIFEST.json contains an invalid entry')
    }
    if (isMetisPath(entry.path)) throw new Error(`manifest must not contain METIS path: ${entry.path}`)
    if (entries.has(entry.path)) throw new Error(`manifest contains duplicate path: ${entry.path}`)
    entries.set(entry.path, { mode: entry.mode, blob: entry.blob })
  }
  return entries
}

function compareIndex(expected, actual) {
  const violations = []
  for (const [filePath, expectedEntry] of expected) {
    const actualEntry = actual.get(filePath)
    if (!actualEntry) {
      violations.push(`${filePath}: missing from Git index`)
      continue
    }
    if (actualEntry.mode !== expectedEntry.mode || actualEntry.blob !== expectedEntry.blob) {
      violations.push(
        `${filePath}: expected mode/blob ${expectedEntry.mode}/${expectedEntry.blob}, ` +
        `got ${actualEntry.mode}/${actualEntry.blob}`,
      )
    }
  }
  for (const filePath of actual.keys()) {
    if (!expected.has(filePath)) violations.push(`${filePath}: not present in upstream manifest`)
  }
  return violations
}

function listUntrackedUpstreamFiles() {
  const raw = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  })
  return raw.toString('utf8').split('\0').filter((filePath) => filePath && !isMetisPath(filePath))
}

function hasWorkingTreeChangesOutsideMetis() {
  const pathspec = ['.', ':(exclude)metis/**']
  return git(['diff', '--quiet', '--no-ext-diff', '--', ...pathspec], true) === null
}

function main() {
  const baseline = readJson(baselinePath, 'DSH_BASELINE.json')
  const manifest = readJson(manifestPath, 'UPSTREAM_MANIFEST.json')
  if (!baseline.commit || manifest.commit !== baseline.commit) {
    throw new Error('baseline commit and manifest commit do not match')
  }

  const expected = parseManifest(manifest)
  const actual = parseIndex()
  const violations = compareIndex(expected, actual)
  for (const filePath of listUntrackedUpstreamFiles()) {
    violations.push(`${filePath}: untracked path outside metis/**`)
  }
  if (hasWorkingTreeChangesOutsideMetis()) {
    violations.push('working tree contains non-index upstream changes outside metis/**')
  }

  if (violations.length > 0) {
    console.error(`[check-dsh-untouched] FAILED: ${violations.length} upstream-integrity violation(s).`)
    for (const violation of violations) console.error(`  - ${violation}`)
    process.exitCode = 1
    return
  }

  console.log(
    `[check-dsh-untouched] OK: ${expected.size} upstream paths match ` +
    `manifest commit ${manifest.commit} (content + Git mode + worktree).`,
  )
}

try {
  main()
} catch (error) {
  console.error(`[check-dsh-untouched] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
