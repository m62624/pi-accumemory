# pi-accumemory

Long-term memory for [pi](https://github.com/earendil-works/pi-coding-agent).

A pi session starts from nothing and ends with nothing. This keeps what was
worth keeping: why the cache in this repository is disabled, which formatter
this team settled on, that you work in Rust. The model can ask about any of it
later, including from a different project. Everything is a local file; nothing
leaves the machine.

Configuration is in **[SETTINGS.md](SETTINGS.md)**. This file explains what the
thing does and how memories are organised; that one has every key, default and
procedure.

## Two kinds of memory

| | holds | read from |
|---|---|---|
| **shared** | what is true of *you* wherever you work | every session, everywhere |
| **project** | what is true of *this* codebase | sessions in that folder (and its subfolders) |

Two databases, not one, because the two answer different questions. A fact about
this repository's build quirks is noise in every other project; a fact about how
you like to work is worth carrying into all of them. The model picks when it
writes, answering one question: would this still be true in another project? Say
nothing and it gets the project memory. That default earns its place, because
the two mistakes do not cost the same. A fact filed in the wrong project is
merely absent elsewhere. A fact filed in the shared memory is present
everywhere, permanently.

The shared database also holds the router: the table saying which folder uses
which project memory.

## Which memory a folder gets

Four ways, in the order they are tried.

**1. It inherits one.** Walking up from where pi started, the first folder that
already has a memory wins. So one memory covers a whole tree: a subfolder uses
the project's, and binding a monorepo root gives every package inside it the
same memory.

**2. A marker is found.** Only if nothing above has a memory. `.git` by default,
`memory.project.markers` to name others (`Cargo.toml`, `go.mod`, whatever this
machine uses). The nearest match wins, the walk is bounded, and your home
directory is never a project by marker however many dotfiles repositories live
there.

**3. You ask for one, with `/longterm-new`.** For the two cases no rule can decide:
a folder with no marker that is nonetheless a body of work, and a folder inside
a project whose facts should not be filed under it. It mints an empty memory
bound to exactly that folder. Being nearer, it then outranks whatever the folder
was inheriting, and everything above is untouched.

**4. You attach an existing one, with `/longterm-rebind`.** For a memory that came
from somewhere else. It lists every memory with its id, size and bound folder,
you pick, it opens. Both commands reopen in place: no restart.

If none of the four applies, the folder has no project memory, and the model is
told what that costs rather than left to guess: what it stores instead goes to
the shared memory and shows up in every other project.

Nothing here is guessed from names or git remotes. A wrong guess merges two
memories, and merged memories cannot be separated again. So the machine shows
what it has, and a person decides.

### Moving between machines

The database files are portable as they are: plugmem writes a snapshot that is
byte-identical on Linux, macOS and Windows, so there is no export step. Copy
`memory/` and `notes/` while pi is not running.

What does not travel is the binding. A project is found by its absolute path,
and that path is different on the other machine. So the copied memory arrives
intact and unreachable, and `/longterm-rebind` is what attaches it.

## How a question is answered

The store is [plugmem](https://github.com/m62624/plugmem): embedded, no server,
bitemporal (a fact has both "when we learned it" and "when it was true").

A recall does not search one index. Four sources run, each producing its own
ranked list:

- **lexical** — BM25 over the fact text;
- **semantic** — vector similarity, if an embedder is configured. Without one
  everything else still works, only wording has to match more closely;
- **graph** — facts reachable through entity links, two hops by default and
  weighted down by distance. The depth is a setting, not a ceiling;
- **temporal** — a time range, for "what happened that week".

They are fused by reciprocal rank, `Σ w/(60 + rank)`, instead of by comparing
scores: BM25 scores and cosine distances are not on the same scale, and
calibrating them against each other is a tuning problem nobody wins. Then a
recency boost (half-life 180 days), then deduplication down each fact's revision
chain to its current version, then greedy selection under a token budget.

Tags, entity and time act as filters over that, not as sources of their own.

Two consequences follow. A recall with only filters and no question returns
nothing, because filters narrow and do not retrieve. And an embedder is
optional but changes what "remembering" means: with one, a question worded
differently from the stored fact still finds it.

## What the model can do

Every tool is prefixed `longterm_`. Deliberately: `pi-telegram-manager`
registers `manager_remember` over the same engine, about a person in a chat, and
two plausible `remember` tools with nothing but a name between them is how a
fact ends up where nobody looks for it.

| tool | what it is for |
|---|---|
| `longterm_ask` | ask this project's memory, or the shared one, or both |
| `longterm_ask_project` | ask a different project's memory |
| `longterm_projects` | list the projects that have one |
| `longterm_remember` | store one durable statement |
| `longterm_revise` | replace a fact that changed; the old version stays as history |
| `longterm_forget` | drop one that was wrong, or one whose moment has passed |
| `longterm_forget_many` | drop a list of them in one write — duplicates, mostly |
| `longterm_tags` | the tags in use, with counts |
| `longterm_link` / `longterm_unlink` | typed relationships between entities |
| `longterm_note_*` | create, read, update and delete notes too long to be facts |
| `longterm_about` | how this memory itself works, one topic per call |

`longterm_about` is the odd one out: it reads no facts. A model asked how its
memory works answers from whatever it can reconstruct, which is a plausible
memory system and not this one, and then acts on that description. So the answer
is a document in this package instead: eight topics (`system`, `turn`, `scopes`,
`writing`, `recall`, `consolidation`, `settings`, `current_settings`), one per
call, three per turn. `current_settings` prints the real paths and the values
this session is running with, resolved by the code that opened them, so "where
do I change that" is answered with a path rather than a convention.

Commands, for you rather than the model: `/longterm-status`, `/longterm-new`,
`/longterm-rebind`, `/longterm-consolidate`, `/longterm-reembed`.

## What it does on its own

**A background pass, when the session goes quiet.** It re-reads the transcript
pi already writes to disk and curates: stores what was missed, collapses
"playing at 20:30 on Saturday" and "playing at 21:00 on Tuesday" into one
undated fact about a habit, drops dated facts whose dates have passed. It stops
the instant you type, and whatever it had decided by then is already saved.

**It keeps out of the prompt's way.** What it adds sits below the transcript and
is rebuilt on three events only: a new message from you, a compaction, or ten
tool calls. Between those the prompt is byte-identical, so the backend's prefix
cache survives. Priced rather than assumed: `tests/session/prefix-reuse.test.ts`
counts the characters, and keeps the counter-example that costs 16,000 of them
per new fact when the same block sits above the transcript instead of below.

**It will not store credentials.** Not tokens, not keys, not passwords, not the
contents of `.env`. This memory is permanent and is read at the start of every
session in every project, so a secret written into it is re-injected into
context indefinitely.

Before every fact, revision, and note write, a local secret scanner checks the
candidate text. The scanner covers known provider tokens, passwords, private
keys, authenticated connection strings, bearer credentials, and other
credential-shaped values. The scanner is broader than the memory policy: the
policy blocks high-confidence credential findings and does not treat every
opaque identifier, UUID, hash, or placeholder as a secret. A blocked write
returns a short explanation with the triggering line and the credential value
redacted, so the model can correct itself without receiving the secret back.

The check is deterministic code, not just an instruction to the model. It runs
offline and never sends the candidate text for provider validation. No detector
can find every possible secret, and this guard protects permanent memory only;
it cannot undo a secret that was already sent in the conversation or to a model.

## Install

```sh
pi package add pi-accumemory
```

It works with no configuration. To have questions match facts worded
differently, switch on an embedder in the engine's own `config.toml`. See
[SETTINGS.md](SETTINGS.md#the-embedder-in-configtoml).

## Where things live

```
<agentDir>/extensions/pi-accumemory/
  settings.json                  see SETTINGS.md
  memory/config.toml             plugmem's own configuration; yours to edit
  memory/db/common.plugmem       facts about you, and the project router
  memory/db/p_<projectId>.plugmem
  notes/                         note bodies, each with a pointer fact
  instructions/defaults/         ours, rewritten on upgrade
  instructions/append/           yours, never touched
  state/consolidation.json       how far the background pass has read
  state/review.json              how far the review job has walked
  state/stumbles.json            mistakes repeated across sessions
```

Paths inside the databases are stored in one canonical form, forward slashes
with the drive letter preserved, and converted to the host's native form only
where they touch the disk. A memory written on Windows reads correctly on Linux.

## Development

```sh
npm install
npm run ci          # biome + tsc + vitest + a packaging dry run
npm run coverage    # vitest with v8 coverage
```

Tests run against an in-memory fake for speed and against the real plugmem addon
in `tests/integration/` for truth. The fake is deliberately faithful about the
things the code depends on: fact ids start at zero, a filter-only recall returns
nothing, `revise` closes instead of overwriting. A forgiving fake is a fake that
lets bugs through.

## Licence

MIT.
