# AGENTS.md — .github (CI / release automation)

## Purpose
GitHub automation for this TypeScript Pi extension: CI, PR labeling, the release-candidate
+ npm publish flow, generated release notes, the Pi SDK watcher, and the Tangled mirror.

## Parent
- `../README.md`, `../SETTINGS.md`

## Stable Contracts
- CI runs `npm run check` (biome, `--error-on-warnings`, so a lint warning FAILS),
  `npm run build` (tsc), `npm run coverage` (vitest with a 90% threshold on all four
  axes), and `npm pack --dry-run`.
- CI also fails when the build leaves files behind — that means `.gitignore` has a hole
  and a coverage report is one commit from entering the history.
- Only the `CI passed` check is a required branch-protection gate — it aggregates the
  real jobs, so branch protection never needs editing when jobs change.
- npm publishing uses **trusted publishing (OIDC)**. The publish job has
  `id-token: write` and must not use `NPM_TOKEN` or `NODE_AUTH_TOKEN`.
- The first package release is published manually from a logged-in terminal because
  npm can only configure trusted publishing after the package exists. Then configure
  npm trusted publishing for `m62624/pi-accumemory`, GitHub Actions, and
  `.github/workflows/release.yml`.
- `--provenance` must stay: it lets users verify that the npm tarball came from this
  repository and commit.
- Release notes depend on PR labels; the labeler and the changelog config must key off
  the same names.
- This is a TypeScript package: never add Rust/bench steps.

## Invariants Checked By Tests
- `tests/workflows.test.ts` — the workflows parse, only call npm scripts that exist,
  keep the single aggregating gate, and mention no other project's name.
- `tests/sdk-boundary.test.ts` — only `src/index.ts` and `src/consolidation/pi-agent.ts`
  import `@earendil-works/*` (index.ts also imports `@earendil-works/pi-tui`, for the
  one thing plain text cannot do: render a tool result differently from what the model
  reads); only `src/storage/plugmem-store.ts` imports `plugmem`. The SDK watcher's
  pass/fail signal means nothing without this.

## Read First
- `workflows/ci.yml`
- `workflows/release.yml`
- `workflows/sdk-watch.yml`

## Secrets And Variables
| name | kind | used by | needed for |
|---|---|---|---|
| `TANGLED_SSH_KEY` | secret | `mirror-tangled.yml` | the Tangled mirror |
| `TANGLED_REMOTE` | variable | `mirror-tangled.yml` | the Tangled remote URL |

`GITHUB_TOKEN` is provided by Actions; nothing needs to be added for it.
