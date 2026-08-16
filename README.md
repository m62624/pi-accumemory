# pi-accumemory

Long-term memory for [pi](https://github.com/earendil-works/pi-coding-agent).

## What problem this solves

A Pi session contains the current conversation. When that session ends, the
next one does not know the project decisions, working preferences, or facts
that the model learned earlier. Putting every old conversation into every new
prompt would be expensive and noisy, and would mix facts from unrelated
projects.

`pi-accumemory` stores selected durable facts locally and retrieves only the
facts that match the next request. The model decides what is worth saving. The
extension decides where it goes, prevents credentials from entering permanent
memory, and keeps the old version when a fact changes.

This is useful for one person or one local agent working across Pi sessions. It
is not a transcript archive, a document store, a cloud knowledge base, or a
multi-user service.

## How the pieces fit

The storage engine is [plugmem](https://github.com/m62624/plugmem), an
embedded, file-backed database. There is no server or separate memory service.
`pi-accumemory` adds the Pi controller and memory policies around it:

```text
Pi request
    ↓
memory controller
    ├─ chooses shared or project memory
    ├─ asks plugmem for ranked context
    ├─ checks model-created writes for credentials
    └─ runs consolidation and review when Pi is idle
    ↓
two local plugmem databases
```

The controller receives a Pi request, asks the appropriate database for a
small ranked context block, and adds that block to the next model prompt. When
the model calls a memory tool, the controller checks the write and passes it to
plugmem. Background consolidation uses the same write path.

## Why there are two databases

The extension keeps shared and project memory in separate plugmem files. They
answer different questions and have different visibility:

| database | stores | used in |
| --- | --- | --- |
| shared | facts about the person and general working habits | every project |
| project | facts about one codebase or work tree | that project and its subfolders |

For example, "I prefer Rust for systems work" belongs in shared memory. "This
repository runs Biome before every commit" belongs in the project database.
The second fact should not appear in an unrelated repository, while the first
should.

These are separate databases, not two views of one table. They have separate
fact ids and separate retrieval indexes. `longterm_ask` can query shared
memory, project memory, or both, then labels the results by scope. A fact is
not copied from one database to the other unless a consolidation pass is
explicitly allowed to promote a project fact to shared memory.

The shared database also contains the router: a small set of facts that maps a
canonical project folder to its project database. The router is not project
content.

## Database, retrieval, and consolidation are different things

The database is the durable storage. It holds facts, revisions, tags, entity
links, metadata, embeddings, and time information.

Retrieval is a read operation. Given a question and a scope, it searches the
selected database, ranks candidates, removes facts that are hidden by a newer
revision, and returns a token-limited context block. Retrieval does not write a
summary and does not move facts between databases.

Consolidation is a write operation started after a quiet period. It reads new
transcript material, asks a temporary Pi agent which parts deserve memory, and
writes the resulting facts through the normal controller. Review is another
write-capable job, but it reads old facts instead of the transcript.

## What the database contains

A fact is one durable statement. It can have:

- text;
- an entity, such as `user`, `project:pi-accumemory`, or `note:n1`;
- tags for exact filtering;
- opaque metadata for small side attributes such as a source URI, MIME type, or external id;
- an optional embedding;
- two time axes: when the statement was true and when the database learned it.

Metadata is stored and returned verbatim, but it is not searched, ranked, or
used as a tag filter. Put searchable meaning in `text`, classification in
`tags`, and only a small pointer or integration attribute in `metadata`. The
public `longterm_remember`, `longterm_remember_many`, and `longterm_revise`
tools accept it. A revision preserves existing metadata when the field is
omitted; passing a new map replaces it, and `{}` clears it. Metadata goes
through the same local secret guard as fact text, so it is not a place for
credentials or large payloads.

When a fact changes, `revise` closes the old fact and stores a new one. That is
why an old answer can still be recovered with an `as_of` query. `forget` marks
a fact as no longer current; maintenance later reclaims its storage.

Long material belongs in a note. A note body lives in its own Markdown file and
its small pointer fact lives in plugmem, so the model can find the note without
putting the whole document into every recall result. User notes are stored
under `notes/common/`; project notes under `notes/projects/<projectId>/`. Use
`longterm_note_update` to change a note. Do not revise its pointer with the
generic fact tool: that pointer contains the metadata needed to find the file.

## How a question is answered

Recall is hybrid. It does not choose between keyword search and vector search;
it can use both, along with relationships and time.

| source | algorithm | finds | needs an embedder |
| --- | --- | --- | --- |
| lexical | BM25 over the fact text | exact terms and related words | no |
| semantic | int8 cosine similarity; flat scan for small sets and HNSW for larger sets | similar meaning when wording differs | yes |
| graph | typed entity edges, with bounded traversal | facts related through people, projects, and other entities | no |
| temporal | indexes over recorded and valid time ranges | what was known or true at a particular time | no |

The engine ranks each source separately and combines the ranks with reciprocal
rank fusion:

```text
score = Σ(weight / (60 + rank))
```

It then applies a recency boost, collapses a revision chain to the current
fact, and selects results under the configured token budget. Tags, entities,
and time ranges narrow the candidates; they are filters, not extra retrieval
algorithms.

Without an embedder, a query usually needs to share words with the stored fact.
With an embedder, a question such as "which runtime do I prefer?" can find a
fact written as "I use Tokio".
BM25, graph, and time retrieval continue to work when no model or network is
available.

For the engine's own file format, bitemporal model, HNSW implementation, and
benchmarks, see the [plugmem README](https://github.com/m62624/plugmem#what-recall-does).

## Who should use it

It is useful when the same Pi installation serves several sessions and the
model repeatedly needs the same small set of facts:

- preferences that apply across repositories;
- project decisions and local conventions;
- facts that changed over time and may need historical answers;
- relationships between projects, notes, people, and tools;
- a local agent that must work without a memory server.

It is not a replacement for the Pi transcript, a document store, or a team
knowledge system. Put a long specification in a note or in the repository.
Store only the fact that lets the model decide when to read it.

## How a folder gets a project database

The model chooses shared memory for facts that apply across repositories and
project memory for facts tied to the current codebase. When it does not specify
a scope, the controller uses project memory when a project database exists.

The controller checks these cases in order:

1. An ancestor already has a bound memory. The nearest binding wins.
2. No binding exists, so project markers are checked. `.git` is the default;
   `memory.project.markers` can add names such as `Cargo.toml` or `go.mod`.
3. `/longterm-new` creates an empty memory for the exact folder.
4. `/longterm-rebind` attaches an existing memory to the folder.

The walk has a parent limit. The home directory is not made into a project
just because it contains repositories. If no project memory applies, writes
go to shared memory and the model is told that they will be visible elsewhere.

The database itself is portable. The binding uses an absolute path, so copying
`memory/` to another machine requires `/longterm-rebind` there.

## What the model can do

All model tools start with `longterm_` so they are distinct from tools provided
by other Pi extensions.

| tool | purpose |
| --- | --- |
| `longterm_ask` | retrieve shared memory, project memory, or both |
| `longterm_ask_project` | retrieve another project's memory |
| `longterm_projects` | list known projects |
| `longterm_remember` | store one durable statement |
| `longterm_remember_many` | store several independent atomic statements in one call; reports each item as stored, blocked, or error |
| `longterm_revise` | replace a changed fact while keeping its history |
| `longterm_forget` / `longterm_forget_many` | mark incorrect or expired facts as forgotten |
| `longterm_tags` | list tags and their current counts |
| `longterm_link` / `longterm_unlink` | add or close typed entity relationships |
| `longterm_note_*` | create, read, update, and delete longer Markdown notes |
| `longterm_about` | read the package's own documentation pages |

`longterm_about` does not retrieve memory facts. It reads fixed documentation
pages for topics such as `system`, `scopes`, `recall`, `consolidation`, and
`settings`. `current_settings` reports the paths and values used by the live
session.

For the person at the terminal, the commands are `/longterm-status`,
`/longterm-inspect`, `/longterm-consolidate`, `/longterm-new`,
`/longterm-rebind`, and `/longterm-reembed`. `/longterm-inspect` opens a
responsive Pi TUI desk: search by meaning, filter by tags, expand a full fact
with metadata and graph links, then select several facts with checkboxes and
forget them in one confirmed batch. It waits until background consolidation or
review has finished, so the list does not change underneath the inspector. Its
result page size is controlled by `memory.inspect.pageSize` in `settings.json`.

## What happens when the model writes

The normal path is:

```text
model calls longterm_remember
    ↓
controller chooses the memory and entity
    ↓
local secret guard checks the candidate
    ↓
plugmem remember_guarded checks nearby facts and writes the fact
```

The duplicate check is scoped to the fact's entity. The engine reports nearby
facts and possible conflicts; the model decides whether to revise, forget, or
keep both.

The secret guard runs before fact, revision, and note persistence. It uses
`@visulima/secret-scanner` plus local checks for common ENV assignments, JWTs,
private-key headers, authenticated database URLs, and bearer credentials. The
scanner is configured for offline operation, so candidate text is not sent to a
provider for validation.

When a write is refused, the model receives a short explanation and a masked
trigger window. It must choose between two actions:

- retry with a sanitized statement that keeps useful context, such as "the
  service reads its API credential from an environment variable";
- do not retry when the information is not useful as durable memory.

The guard does not silently rewrite the original call. It never puts the
credential value back into its refusal message. This protects permanent memory;
it cannot erase text that has already appeared in the conversation or reached a
model.

Ordinary UUIDs, hashes, placeholders, and opaque identifiers are not rejected
just because they are long. The detector is intentionally broad around
credential context and conservative around unlabelled identifiers. No local
detector can recognize every possible secret, so credentials should still stay
out of prompts and transcripts whenever possible.

Sensitive ENV names are matched by components, not only when the name starts
with the sensitive word: `MY_SECRET`, `SERVICE_API_TOKEN`, and `DB_PASSWORD`
are covered when the assigned value looks credential-like. Plain configuration
values remain allowed, including `TOKEN_LIMIT=100`, `SECRET_MODE=enabled`, and
`PASSWORD_POLICY=strict`.

Custom organization-specific credential patterns can be added under
`memory.security.customPatterns`. They are additive only: built-in rules cannot
be disabled or overridden, and there are no `allow` patterns. The guard checks
built-in rules first, then these custom patterns, then the broad offline
scanner. Invalid regexes are ignored with a startup warning.

## Automatic memory work

The model writes during a normal turn. Two separate background jobs handle
memory it missed and facts that have become old enough to inspect.

### Consolidation after quiet time

After Pi emits `agent_settled`, the extension waits seven minutes by default.
That event means the model response and its tool calls are finished. A tool
call does not start the timer by itself. If a new user message arrives, the
timer is cancelled and starts over after the next settled turn.

The consolidation agent reads new transcript material, stores durable facts it
finds, merges repeated dated observations into a broader fact, and drops facts
whose validity has ended. It stops when you type. Its temporary Pi session is
not written to the Pi JSONL history and does not appear in `/resume`.

### Review every 30 minutes

Review is a separate scheduler. Every 30 minutes by default, while Pi is
running, it shows the model a window of older stored facts. It does not need a
new user message and does not read the conversation. The review cursor moves
forward and wraps, so the whole memory is inspected over time. A fact is not
deleted merely because it is old; the model must decide that it is expired,
duplicated, or contradicted.

The two jobs have separate schedules and budgets. The seven-minute timer is
for new transcript material. The 30-minute timer is for old facts. Their
activity counters are reset when the corresponding job starts, so a job does
not immediately trigger another one.

### Reminder to save

The live model also gets a reminder after 20 user messages or 30 tool calls
without a memory write. The reminder is not a save operation and does not start
consolidation. After it appears, it stays quiet for 15 turns. A write resets
the counters.

The full settings reference, including how to change these values, is in
[SETTINGS.md](SETTINGS.md).

## What the person sees

Background jobs show a start notification, one animated status line, and a
finish or interruption notification. The agent conversation remains private and
ephemeral. Memory writes go to the normal database immediately.

## Where files live

```text
<agentDir>/extensions/pi-accumemory/
  settings.json                  extension settings
  memory/config.toml             plugmem configuration
  memory/db/common.plugmem       shared facts and the project router
  memory/db/p_<projectId>.plugmem
  notes/                         Markdown note bodies
  instructions/defaults/         bundled instructions, refreshed on upgrade
  instructions/append/           user instructions, never touched
  state/consolidation.json       transcript-pass cursor
  state/review.json              old-fact review cursor
  state/stumbles.json            repeated mistakes across sessions
```

Copy `memory/` and `notes/` while Pi is not running. Rebind the copied project
memory on the destination machine because absolute folder bindings do not move
with the files.

## Install

```sh
pi install npm:pi-accumemory
```

The extension works with defaults. To match questions by meaning as well as by
words, configure an embedder in plugmem's `config.toml`; see
[the embedder section in SETTINGS.md](SETTINGS.md#the-embedder-in-configtoml).

## Development

```sh
npm install
npm run ci          # Biome, TypeScript, tests, and package dry run
npm run coverage    # Vitest with V8 coverage
```

Tests use in-memory fakes for fast unit coverage and the real plugmem addon in
`tests/integration/`. The fakes preserve the engine behavior this extension
depends on: fact ids start at zero, filter-only recall returns nothing, and
`revise` closes rather than overwrites a fact.

## Licence

MIT.
