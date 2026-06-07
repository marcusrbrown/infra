---
name: generate-readme
description: Create or update README.md with accurate project documentation
argument-hint: "[full|section-name]"
---

# Generate README Documentation

Update the project's README.md with comprehensive, accurate documentation.

## Arguments

<scope>
$ARGUMENTS
</scope>

**If scope is empty or "full":** Complete README rewrite **If scope contains a section name:** Focus on updating that section only

## Pre-Injected Context

<package-info>
!`cat package.json`
</package-info>

<workspace-packages>
!`cat apps/*/package.json packages/*/package.json 2>/dev/null | jq -s '[.[] | {name, version, description, private}]'`
</workspace-packages>

<current-readme>
@README.md
</current-readme>

<workflows>
!`for f in .github/workflows/*.yaml; do echo "### $(basename "$f")"; head -3 "$f" | grep "name:"; echo; done`
</workflows>

<repo-structure>
!`find . -not -path './node_modules/*' -not -path './.git/*' -not -path './apps/keeweb/dist/*' -not -path './apps/keeweb/.cache/*' -type f | sort | head -40`
</repo-structure>

<recent-changes>
!`git log --oneline -15`
</recent-changes>

<badges>
The root README header carries a single centered badge row, in this order. Use `style=flat-square` for shields.io badges; GitHub-native workflow badges (`actions/workflows/<file>/badge.svg`) carry no style param.

```html
<p align="center">
  <a href="https://www.npmjs.com/package/@marcusrbrown/infra"><img src="https://img.shields.io/npm/v/@marcusrbrown/infra?style=flat-square" alt="npm version"></a>
  <a href="https://github.com/marcusrbrown/infra/actions/workflows/ci.yaml"><img src="https://github.com/marcusrbrown/infra/actions/workflows/ci.yaml/badge.svg" alt="CI"></a>
  <a href="https://github.com/marcusrbrown/infra/actions/workflows/codeql.yaml"><img src="https://github.com/marcusrbrown/infra/actions/workflows/codeql.yaml/badge.svg" alt="CodeQL"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/marcusrbrown/infra"><img src="https://api.scorecard.dev/projects/github.com/marcusrbrown/infra/badge?style=flat-square" alt="OpenSSF Scorecard"></a>
  <a href="https://github.com/marcusrbrown/infra/blob/main/LICENSE"><img src="https://img.shields.io/github/license/marcusrbrown/infra?style=flat-square" alt="License"></a>
</p>
```

Badge sources are constrained by reality: only `@marcusrbrown/infra` (`packages/cli`) is published, so the npm badge applies to the root and `packages/cli` only. Workflow badges use the GitHub-native endpoint (renders the last completed run's conclusion, correct even for environment-gated deploy workflows). Never add a badge whose endpoint does not resolve — verify with `curl -sI` before introducing a new one.
</badges>

## Execution Flow

### Phase 1: Analyze Context

1. From `<current-readme>`: Understand existing structure and style
2. From `<package-info>`: Extract root workspace metadata
3. From `<workspace-packages>`: List all apps and packages with descriptions
4. From `<workflows>`: Document CI/CD and automation workflows
5. From `<repo-structure>`: Build accurate directory tree
6. From `<recent-changes>`: Note recent features and fixes

If scope specifies a single section, only update that section.

### Phase 2: Content Mapping

| README Section       | Data Source                                             |
| -------------------- | ------------------------------------------------------- |
| Header + Badges      | Centered badge row (npm, CI, CodeQL, Scorecard, License) + repo metadata |
| Overview             | package-info description + workspace-packages           |
| Prerequisites        | Bun version requirement                                 |
| Quick Start          | Install + build commands                                |
| Apps                 | workspace-packages (apps/\*) with build/deploy commands |
| CLI                  | workspace-packages (packages/cli) with usage            |
| CI/CD                | workflows list, environment protection, secrets table   |
| Repository Structure | repo-structure tree                                     |
| Development          | Lint, typecheck, format commands                        |
| License              | package-info                                            |

### Phase 3: README Generation

#### Formatting Rules

1. **Badges**: Centered `<p align="center">` row per the `<badges>` block — npm version, CI, CodeQL, OpenSSF Scorecard, License. shields.io badges use `style=flat-square`; GitHub-native workflow badges carry no style param. Only add a badge whose endpoint resolves.
2. **Code blocks**: Use `bash` for shell, `json` for config, `text` for directory trees
3. **Tables**: Use for secrets, workflows, package listings
4. **No secrets**: Never include real secret values, only placeholder references

#### Section Order

1. Header (title + description + badges)
2. Overview
3. Prerequisites
4. Quick Start
5. Apps (one subsection per app)
6. CLI
7. CI/CD (workflows, secrets, environments)
8. Repository Structure
9. Development (lint, typecheck, hooks)
10. License

### Phase 4: Quality Verification

- [ ] All workspace packages listed accurately
- [ ] All workflows documented
- [ ] No real secrets or credentials
- [ ] All referenced file paths exist
- [ ] Badge URLs are valid
- [ ] Commands are correct and tested

### Phase 5: Write and Verify

1. Write README.md
2. Report: sections updated, packages listed, changes from previous version
