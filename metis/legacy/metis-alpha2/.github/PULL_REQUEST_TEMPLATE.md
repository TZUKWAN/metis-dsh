## Summary

Describe the user-facing or engineering outcome of this pull request.

## Motivation and Scope

- Related issue:
- Problem being solved:
- In scope:
- Explicitly out of scope:

## Changes

- Describe each material change and the files or modules it affects.
- Call out contract, schema, persistence, IPC, security, or dependency changes.

## Verification

Record commands actually run and their results. Do not mark an item complete if
it was not executed.

- [ ] Focused unit or regression tests
- [ ] Integration tests for affected boundaries
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Packaged application or end-to-end verification, when applicable

Commands and results:

```text
Command:
Result:
```

## Risk and Safety Review

- [ ] No credentials, private research data, user databases, or machine-specific
      absolute paths are included
- [ ] New or changed IPC input and output are validated
- [ ] File access, shell execution, external navigation, and network behavior
      preserve existing security boundaries
- [ ] Persistence migrations and rollback or recovery behavior were considered
- [ ] No test, approval, provenance, or release gate was weakened or bypassed

Describe remaining risks and mitigations:

## User Interface Evidence

For visible changes, attach before-and-after screenshots and describe keyboard,
responsive-layout, theme, and accessibility checks. Remove private content from
all screenshots and logs.

## Documentation and Release Impact

- [ ] README, contributor documentation, and security documentation are current
- [ ] Release notes or migration notes are included when behavior changes
- [ ] No generated build, test, coverage, database, or local-agent artifacts are
      included

By submitting this pull request, the contributor agrees that the contribution is
licensed under the repository's Apache License 2.0 and follows
[CONTRIBUTING.md](../CONTRIBUTING.md) and the
[Code of Conduct](../CODE_OF_CONDUCT.md).
