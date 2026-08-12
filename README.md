# pi-accumemory

Long-term memory for [pi](https://github.com/earendil-works/pi-coding-agent),
carried across sessions and across projects.

Every pi session starts from nothing. This gives it somewhere to keep what it
learned: why the cache in this repository is disabled, which formatter this team
uses, that you prefer Rust for systems work — and lets it ask about any of that
later, including from a different project.

Built on [plugmem](https://github.com/m62624/plugmem): a local, embedded,
bitemporal fact store. No server, no cloud, nothing leaves the machine.

## What it actually does

**One database per project, plus one shared one about you.** The project memory
holds what is true of *this* codebase. The shared one holds what is true of you
wherever you work, and the router that says which folder is which project.

**Moving a project folder does not lose its memory.** The project id is minted
once and never derived from the path, so a move revises a single fact. A key
derived from the live path would orphan the database and silently start a
second, empty one.

**The model can ask.** `longterm_ask` takes a question in ordinary words, mid-
task: it opens a file, sees a disabled optimisation, and asks *why* instead of
guessing or asking you again. `longterm_ask_project` asks another project's
memory — read-only, so it works while you have a session open there.

**It forgets on purpose.** A background pass runs when the session goes quiet,
re-reading the transcript pi already writes to disk. It collapses "playing at
20:30 on Saturday" plus "playing at 21:00 on Tuesday" into one undated fact
about a habit, and drops the dated ones once their dates have passed.

**It stays out of the prompt's way.** Everything it adds sits below the
transcript and is rebuilt only on three events — a new message from you, a
compaction, or ten tool calls. Between those the prompt is byte-identical, so
the backend's prefix cache survives. That is measured, not assumed:
`tests/session/prefix-reuse.test.ts` prices it in characters, and keeps the
counter-example that costs 16,000 characters per new fact when the same block
sits above the transcript instead of below it.

## Install

```sh
pi package add pi-accumemory
```

It works immediately with no configuration. For the memory to answer questions
phrased differently from how a fact was written, switch on an embedder — see
[SETTINGS.md](SETTINGS.md#the-embedder--memoryembedder).

## Tools

Every name is prefixed `longterm_`. That is deliberate: `pi-telegram-manager`
registers `manager_remember` over the same engine, about a person in a chat, and
two plausible `remember` tools with nothing but a name to tell them apart is how
a fact ends up where nobody looks for it.

| tool | what it is for |
|---|---|
| `longterm_ask` | ask this project's memory, or the shared one, or both |
| `longterm_ask_project` | ask a different project's memory |
| `longterm_projects` | list the projects that have one |
| `longterm_remember` | store one durable statement |
| `longterm_revise` | replace a fact that changed; the old version stays as history |
| `longterm_forget` | drop one that was wrong, or one whose moment has passed |
| `longterm_tags` | the tags in use, with counts |
| `longterm_link` / `longterm_unlink` | typed relationships between entities |
| `longterm_note_*` | create, read, update and delete notes too long to be facts |
| `longterm_about` | how this memory itself works, one topic per call |

`longterm_about` is the odd one out: it reads no facts. A model asked how its
memory works answers from whatever it can reconstruct, which is a plausible
memory system rather than this one — and then acts on that description. So the
answer is a document in this package instead: eight topics (`system`, `turn`,
`scopes`, `writing`, `recall`, `consolidation`, `settings`, `current_settings`),
one per call, three per turn. The pages can be long because only the turn that
asks for one pays for it, which is what the always-on instructions can never do.

`current_settings` prints the real path of the settings file and of the
databases, resolved by the code that opened them - so the model answers "where do
I change that" with a path rather than a convention.

Commands: `/longterm-status`, `/longterm-consolidate`, `/longterm-reembed`.

## What it will not store

Credentials. Not tokens, not keys, not passwords, not the contents of `.env`.
This memory is permanent and is read at the start of every session in every
project, so a secret written into it is re-injected into context indefinitely.
The rule is in the shipped instructions, in the tool description, and is
composed *below* anything you add — so your own additions can only make it
stricter.

## Where things live

```
<agentDir>/extensions/pi-accumemory/
  settings.json                  see SETTINGS.md
  memory/db/common.plugmem       facts about you, and the project router
  memory/db/p_<projectId>.plugmem
  notes/                         note bodies, each with a pointer fact
  instructions/defaults/         ours, rewritten on upgrade
  instructions/append/           yours, never touched
  state/consolidation.json       how far the background pass has read
  state/review.json              how far the review phase has walked
  state/stumbles.json            mistakes repeated across sessions
```

Paths inside the databases are stored in one canonical form — forward slashes,
drive letter preserved — and converted to the host's native form only where they
touch the disk. A memory written on Windows reads correctly on Linux.

## Development

```sh
npm install
npm run ci          # biome + tsc + vitest + a packaging dry run
npm run coverage    # vitest with v8 coverage
```

Tests run against an in-memory fake for speed and against the real plugmem addon
in `tests/integration/` for truth. The fake is deliberately faithful about the
things the code depends on — fact ids start at zero, a filter-only recall
returns nothing, `revise` closes rather than overwrites — because a forgiving
fake is a fake that lets bugs through.

## Licence

MIT.
