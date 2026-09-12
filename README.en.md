# dsh-plugin-migration-workbuddy

Migrate WorkBuddy sessions, memories, MCP drafts, and automation tasks into DSH.

The plugin works out of the box and exposes a settings flow: **scan → preview → explicit confirmation
→ import → auditable manifest**. Opening the page performs only a local **read-only** scan; it never
copies, moves, or modifies WorkBuddy data.

## Install

The package ships a `cordis.patch.yml` and declares itself a profile bundle through
`dsh.bundle.patch`, so `dsh plugin add` mounts it as a dependency **and** as a profile layer — no
hand-written composition row needed.

### From GitHub (available today)

```bash
# pinned to a tag: a later push cannot change what actually runs
dsh plugin --profile <name> add github:dingguangyi0/dsh-plugin-migration-workbuddy#v0.1.0
```

A git install fetches **sources, not built artifacts**, so this package ships a `prepare` script that
pnpm runs after install to build `lib/` from `src/`. pnpm ≥10 refuses to run it until it is
allowlisted, so the first `add` fails and prints a package key — copy it into that profile's
`pnpm-workspace.yaml` and retry:

```yaml
allowBuilds:
  dsh-plugin-migration-workbuddy: true
```

That allowance is **permission to execute the package's code on your machine at install time**,
outside any sandbox. Only allow packages whose source you trust, and pin a tag or commit.

### From a local checkout

```bash
dsh plugin --profile <name> add /absolute/path/to/dsh-plugin-migration-workbuddy
```

### From a distribution artifact (no build permission needed)

```bash
# once published to a registry (flip package.json private to false and pick a license first)
dsh plugin --profile <name> add dsh-plugin-migration-workbuddy

# or hand out the tarball
pnpm pack     # produces dsh-plugin-migration-workbuddy-0.1.0.tgz
dsh plugin --profile <name> add ./dsh-plugin-migration-workbuddy-0.1.0.tgz
```

Both forms build `lib/` at publish time, so users never need to grant a build permission.

### Turning it off

Override the row by id in your own `$DSH_HOME/profiles/<name>/cordis.patch.yml`:

```yaml
- id: migration-workbuddy
  disabled: true
```

Restart DSH and the settings page shows “Migration & backup”.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | When false the plugin never touches the disk |
| `maxFileBytes` | `10485760` | Per-source-file limit (1 KiB – 100 MiB) |
| `maxFiles` | `5000` | Files scanned in one pass |
| `toolMode` | `narrative` | `narrative` flattens tool calls/results into text, so imported history carries no tool protocol and always continues; `transcript` keeps the full protocol |
| `automationModelId` | `''` | Model id written into every migrated automation rule; empty uses the deployment default |
| `automationModelAllowlist` | `[]` | Model ids carried over verbatim; everything else is rewritten to `automationModelId` with an `automation-model-remapped` loss |

The source root is `$WORKBUDDY_HOME` or `~/.workbuddy`; the target root is `$DSH_HOME` or `~/.dsh`.

## What moves

- **Sessions**: JSONL messages, reasoning, and tool calls/results become DSH `SessionEvent` records,
  idempotent by source SHA-256. Repeats are skipped; only changed content or metadata is replaced.
  Tool calls write both the model-facing assistant `tool-call` block and the audit event; orphan
  calls/results receive synthetic pairs that keep later turns valid and are recorded as losses. When
  the source repeats a row for the same `callId`, the converter deduplicates by call id (at most one
  `tool-call` block and one `tool/result` per call), avoiding `Duplicate tool output`. Imported
  sessions persist as a seed prefix (`isSeeded` plus an exact `inheritedEventCount`), so the runtime
  never replays imported history as live.
  The read-only `workbuddy.db` catalog separates workspace mode from session mode: workspace-mode
  sessions use their authoritative `cwd`, while session-mode sessions share
  `$DSH_HOME/workspaces/session-mode` (titled “Session mode”). Official titles prefer
  `custom_title`/`title` and are persisted as a valid `session/title` event, so the first user
  message never becomes the displayed name.
  Source deletions are respected: a session whose `sessions.deleted_at` is set is skipped entirely
  instead of being resurrected from a leftover `.jsonl`, and a session whose workspace directory is
  gone is skipped too, so deleted workspaces are never recreated. The preview status line reports the
  excluded count; the filesystem scan itself has no delete flag — the truth comes from `workbuddy.db`.
- **On-demand import**: single-click the sessions card to select/clear all importable items,
  double-click for precise selection. The picker is a workspace × session two-level drill-in — the
  left column lists workspaces (group checkboxes, per-status counts), the right column lists that
  workspace's sessions (status filter, title/path search, per-session checkboxes, loss tooltips);
  ungrouped sessions are selectable one by one. Server-side `sessionKeys`/`workspaceIds` filters run
  before conversion, and unknown selection entries become an `unknown-selection-key` audit loss
  without affecting other imports.
- **Memories**: Markdown/JSON candidates are parsed, deduplicated, and stored under
  `$DSH_HOME/migration/memory/`; `AGENTS.md` is never written and nothing is injected into the
  system prompt.
- **MCP**: only names, URLs, transports, commands, and safe args. Tokens, cookies, API keys, OAuth
  values, and credential files are never migrated; credentials must be re-established on the
  deployment side.
- **Automation tasks**: the `automations` table is read, the supported RRULE subset converts to
  cron, and rules support per-rule selection and manifest idempotency; run history and runtime state
  do not move. Model remapping follows the table above — the source model vocabulary
  (`auto`/`fast-model`/`glm-*`/`kimi-*`, …) usually does not exist on another deployment, and passing
  it through makes every rule fail at run time with an unknown model. The rule shape is the contract
  form `target: { mode: 'new-session', workspaceId }`.

### The automation channel is optional

Rules are persisted through whichever channel the deployment registers (the service name
`automationImport`; some deployments also register a compatibility alias). **The plugin is fully
usable without one**: the preview still lists automation drafts but marks them ineligible, and an
explicit automation import skips them with an `automation-channel-unavailable` loss instead of
failing the batch. Sessions, memories, and MCP are unaffected.

## Security boundaries

- Every scan is read-only, and routes accept **loopback same-origin** requests only.
- Preview paths pass through `sanitizePathForPreview`, and credential-shaped fields are dropped
  during parsing.
- Attachments, branches, original system prompts, and full legacy SQLite restoration are not
  supported yet. DSH has no generic physical session-delete API, so rollback is archive-and-audit.

## Development

```bash
pnpm install
pnpm run build       # tsdown (Host ESM + Client CJS) + tsc declarations
pnpm run typecheck
pnpm run test
pnpm run check       # all three in sequence
```

Artifacts land in `lib/`: `lib/index.js` for the Host half and `lib/client.js` for the Client half
(self-registering into `window.__ModuleLoader__` under the package name).

`prepare` is the install-time entry point (pnpm runs it after a git install). It is the same chain as
`build` without the directory clean, uses only this package's own devDependencies, and assumes no
monorepo context — which is what lets a git install build successfully.

## Notes

This package was put together from an earlier WorkBuddy migration implementation and re-cut as an
independent plugin: the plugin id, settings id, copy, and CSS prefixes all live in this package's own
namespace; routes are `/api/migration/workbuddy/*`; the target home follows DSH's `$DSH_HOME`
(`~/.dsh` by default); and automation rule persistence went from a required dependency to an
optional channel (see above).

The license is not decided yet (`package.json` is `UNLICENSED` with `private: true`); publishing
requires choosing a license and flipping `private` to `false`.
