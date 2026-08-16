# Settings

Everything lives in one file:

```
<agentDir>/extensions/pi-accumemory/settings.json
```

`<agentDir>` is normally `~/.pi/agent`. The file is optional: with no file at
all the defaults below apply, and the extension works.

Every key is optional and is overlaid on the defaults. A **misspelled key** is
reported as a warning and ignored; a key of the **wrong type** is a loud error
naming the full path, because coercing `"25"` into `25` works right up until the
day it does not.

## The complete file, with defaults

<!-- settings-example -->
```json
{
	"timezone": null,
	"memory": {
		"enabled": true,
		"output": "short",
		"recallTokenBudget": 512,
		"recallK": 0,
		"graphDepth": null,
		"manifest": true,
		"queryMaxChars": 600,
		"plugmemConfig": null,
		"autoReembed": true,
		"refresh": {
			"afterToolCalls": 10,
			"onCompact": true,
			"askHintAfterIdleInferences": 2
		},
		"project": {
			"markers": [".git"],
			"maxParents": 16
		},
		"instructions": {
			"alwaysMax": 8,
			"alwaysMaxChars": 1200
		},
		"notes": {
			"overviewMaxChars": 4000
		},
		"nudge": {
			"enabled": true,
			"afterMessages": 20,
			"afterToolCalls": 30,
			"cooldownTurns": 15
		},
		"inspect": {
			"pageSize": 40
		},
		"consolidation": {
			"enabled": true,
			"quietMs": 420000,
			"maxSteps": 12,
			"maxNudges": 2,
			"maxTranscriptChars": 20000,
			"promoteToCommon": true,
			"review": {
				"enabled": true,
				"intervalMs": 1800000,
				"sampleSize": 12
			},
			"habits": {
				"enabled": true,
				"afterSessions": 3
			},
			"maintain": true
		},
		"crossProject": {
			"enabled": true
		}
	}
}
```
<!-- /settings-example -->

## `timezone`

`null` uses the host's zone. Set it to an IANA name (`"Asia/Almaty"`) to pin it.

It matters more than it looks: the current time is injected into every prompt,
and it is the only way the model can tell that a fact about "Saturday at 20:30"
describes something that has already happened. A wrong zone retires facts a day
early or a day late.

An invalid zone falls back to the host's rather than failing the session.

## Reading: `memory.refresh.*`

These decide **when the memory block is recomputed**. Between those moments the
prompt tail is byte-identical, which is what keeps the backend's prefix cache
intact.

| key | default | what it does |
|---|---|---|
| `refresh.afterToolCalls` | `10` | tool calls before the block is rebuilt mid-loop, from what the model has just learned rather than from the original request. `0` disables it |
| `refresh.onCompact` | `true` | rebuild right after a compaction — the worst moment to hold a stale block, since the history it summarised is gone |
| `refresh.askHintAfterIdleInferences` | `2` | after this many replies with no tool call at all, add a line reminding the model it can *ask* its memory. `0` disables it |

A new user message always rebuilds the block. That is not a setting. It is the
definition of a topic change.

| key | default | what it does |
|---|---|---|
| `memory.recallTokenBudget` | `512` | how much of the context window one recall may spend |
| `memory.recallK` | `0` | maximum facts per recall; `0` leaves the engine's own default |
| `memory.graphDepth` | `null` | hops to follow along entity links; `null` uses the engine's own default, which is 2. Not a maximum: the walk is bounded by its entity and edge budgets, so a larger number costs more work rather than reaching further than allowed |
| `memory.inspect.pageSize` | `40` | maximum number of matching facts loaded for one inspector search; the terminal height may show fewer rows |
| `memory.manifest` | `true` | the one-line inventory shown once at session start, so the model knows there is something to ask about |
| `memory.queryMaxChars` | `600` | ceiling on the recall query. Lexical retrieval degrades as terms pile up, and a pasted wall of text drowns the words that identify the question |
| `memory.output` | `"short"` | how much of what a memory tool did is printed **in your terminal**. See below |

## What you see when the memory is used: `memory.output`

This setting changes **only what you see**. The model is always told everything:
which memory the fact landed in, under which entity, with which tags, and which
tags that memory already uses. Each of those is something it cannot recover on
its own and needs later: the scope to address the fact at all (the two memories
number their facts separately), the entity because that is what the duplicate
guard compares against, and the tag vocabulary because filtering matches tags
exactly, so a second spelling splits the pile and neither half ever answers the
other's question.

It covers every memory tool, not only writes. An id is how the model addresses a
fact, so `Forgot [f2], [f5], [f6], [f7]` is exactly right for the model and says
nothing to you. In `short` every tool answers you in its own words instead:

```
Stored [f7] in your memory about the user: "prefers Rust for systems work"
Forgot 4 facts from your memory about the user.
  [f2] [f5] [f6] [f7]  "pi-accumemory is a long-term memory extension for pi"
Asked this project (app): "why is the cache off" - 3 facts.
Read the "scopes" page of longterm_about (2.6 kB).
```

The text always comes from the database, never from the model. At the moment of
a deletion the model no longer has the fact in front of it, so anything it wrote
there would be a guess.

| value | what the terminal shows |
|---|---|
| `"short"` (default) | one line per call, as above |
| `"full"` | everything the model was told. Useful while you are tuning tags or watching what lands where |
| `"hidden"` | nothing at all |

The old name `memory.writeOutput` still works and is read as `memory.output`,
with a warning at startup.


## Writing: `memory.nudge.*`

There is **no** automatic "save a summary of every turn". The model stores what
it judges durable; this is only the reminder that it has not stored anything in
a while. This reminder is independent from the background consolidation timer:
it adds a prompt hint to a live agent run, but it does not start a consolidation
pass and does not write a fact by itself.

| key | default | what it does |
|---|---|---|
| `nudge.enabled` | `true` | switches the reminder off entirely |
| `nudge.afterMessages` | `20` | messages with nothing stored before it appears |
| `nudge.afterToolCalls` | `30` | tool calls with nothing stored before it appears. Separate from the message count because an agentic run grows in tool calls without growing in messages |
| `nudge.cooldownTurns` | `15` | turns of silence after it fires. Without this it repeats every turn until something is written, which is how a hint becomes nagging the model learns to skip |

## The background pass: `memory.consolidation.*`

When the session has been quiet for a while, a pass re-reads the transcript pi
already wrote to disk and curates the memory from it: storing what was missed,
collapsing repeated dated facts into one undated pattern, and dropping what has
expired. It yields the instant you type, and everything it had decided by then
is already saved. The quiet period starts after Pi emits `agent_settled`: the
model's response and all its tool calls are finished, with no retry, compaction
retry or queued follow-up left. A tool call does not itself start this timer.

The pass is independent from `nudge`. When the timer starts the nudge counters
are cleared. If the nudge is shown during a live run, the idle timer has already
been interrupted for that run and starts over only after the next
`agent_settled`, so the two mechanisms do not overlap.

| key | default | what it does |
|---|---|---|
| `consolidation.enabled` | `true` | switches the pass off. Memory still works; only what the model saved itself is kept |
| `consolidation.quietMs` | `420000` (7 min) | silence after `agent_settled` before a pass starts. A boundary meaning "work has stopped", not a budget |
| `consolidation.maxSteps` | `12` | tool calls before the pass is told to wrap up. This bounds a *confused* pass, not a busy one — whatever is left is picked up by the next pass from the same place |
| `consolidation.maxNudges` | `2` | how many times a pass that produced no action is nudged before being abandoned |
| `consolidation.maxTranscriptChars` | `20000` | how much transcript one pass reads. A cursor records how far it got, so a long session is digested by several small passes |
| `consolidation.promoteToCommon` | `true` | lets the pass move a fact confirmed in several projects into the shared memory |
| `consolidation.review.enabled` | `true` | switches the automatic old-fact review on or off |
| `consolidation.review.intervalMs` | `1800000` (30 min) | milliseconds between automatic review passes. This is separate from `consolidation.quietMs` |
| `consolidation.review.sampleSize` | `12` | the review window: how many old facts one pass looks at, per memory. A **floor** — see below |
| `consolidation.habits.enabled` | `true` | the pass's habit phase: a mistake the model has repeated across sessions. See below |
| `consolidation.habits.afterSessions` | `3` | separate sessions a mistake must appear in before it is raised |
| `consolidation.maintain` | `true` | reclaim the disk of forgotten facts at the end of a pass |

## Automatic review: `consolidation.review.*`

The transcript pass and old-fact review are separate automatic jobs. The
transcript pass waits `consolidation.quietMs` after a main agent run and reads
new conversation. The review scheduler runs every `intervalMs` while Pi is
alive, even when nobody has written anything new. It reads old facts only; it
does not read or add messages to the conversation.

Each automatic job uses a temporary in-memory Pi session. It is not written to
the session JSONL files and does not appear in the `/resume` picker. The main UI
shows start/finish notifications and one small animated status line;
the job's memory writes still go to the normal database immediately.

Before any fact, revision, or note is persisted, a local secret scanner checks
the candidate. High-confidence credential findings are blocked, with a safe
redacted trigger line returned to the model; ordinary identifiers, hashes and
placeholders are not automatically blocked. The scan is offline and does not
send candidate text to a provider. This protects permanent memory, not the
conversation or any model context that already saw the text.

The first phase reads the transcript, so it only ever weighs what was just
discussed. The separate review leaves no fact stranded: a fact learned six
months ago and never mentioned since is still eventually reconsidered, not
because it is old, but because the review cursor puts it in front of the model.

The review job shows the model a window of the **oldest** stored facts and asks
one question of each: does this still earn its place. The window walks forward
every review pass and wraps at the end, so the whole memory is covered over time
and nothing is shown twice in a row.

It runs even when the transcript has nothing new (an idle machine is exactly
when there is time for it), and it is a separate agent run with its own step
budget, so the transcript pass cannot eat the review budget before it starts.

Nothing here deletes on a rule. The model decides; a fact is dropped only when
its date has passed, it duplicates another, or it is contradicted. "Old" is not
a reason, and the instruction says so.

### On a memory that is not small

`sampleSize` is a floor, not the window. A fixed window does not survive a
memory that has been running for a year: twelve facts a pass walks ten thousand
of them in 830 passes, which at a handful of idle passes a day is most of a year
to come round once, and the facts most likely to have gone stale are exactly
the ones such a memory would review least.

So the window grows with what the memory holds, to keep a full cycle at roughly
a hundred passes, with a ceiling of eight times `sampleSize` because the window
ends up in a prompt:

| live facts | window | passes to cycle |
|---|---|---|
| 100 | 12 | 9 |
| 1 000 | 12 | 84 |
| 10 000 | 96 | 105 |
| 100 000 | 96 | 1 042 |

The last row is the ceiling doing its job rather than a failure: at a hundred
thousand facts nothing bounded reviews everything quickly, and a prompt holding
a thousand facts would be worse than a slow cycle. Raising `sampleSize` raises
both the floor and the ceiling.

The window is also *fetched* as a window. The engine pages at 128 facts and
answers a page in 0.3 ms; reading to the end of ten thousand facts costs 23 ms
and builds ten thousand objects to throw all but the window away.

## Habit learning: `consolidation.habits.*`

The transcript and review jobs curate what the memory *knows*. This one is about how the
model *uses* it.

Inside one session, a failing call that is sent twice gets a sharper answer and a
third gets a hard stop. None of that survives the session. So a model that opens
five sessions in a row with the same wrong call is corrected five times and
learns nothing: every correction dies with the process that issued it.

The runtime therefore names its own refusals (`id_without_scope`,
`duplicate_refused`, and four others) and counts them in
`state/stumbles.json`. It counts **sessions, not calls**: a kind is credited with
a session only once it happens twice inside it, because one mistake is not a
habit and twenty in one sitting are still one sitting.

Above `afterSessions`, the pass shows the model that one habit and asks it to
write **one** standing rule about it: a fact tagged `instruction` + `always`,
stored in the memory about the user, read at the top of every turn of every later
session. One habit per pass, never four: each rule is charged to every future
request.

Nothing here writes anything. Deciding the habit does not deserve a rule is a
legitimate outcome, and the phase says so. A phase that cannot end in "no" is a
machine for manufacturing rules.

### The ceiling is enforced, not requested

A standing rule is the only thing the model can write that costs it context
forever. So `instructions.alwaysMax` and `instructions.alwaysMaxChars` are a
**hard limit**: a rule that the always-block could not show is refused at the
write, and the refusal lists the rules already standing so that replacing one is
reachable. Ordinary facts are untouched by this: only the `instruction` +
`always` pair.

### When a rule does not work

A kind is marked covered once a rule has been written, so no second one is
proposed for it, but counting continues. A habit that goes on after its rule is
not a model that will not learn: it is a rule saying the wrong thing, or a tool
behaving differently from its description. Writing a third commandment would
spend permanent context to hide our own bug, so `/longterm-status` reports it to
you instead.

## Reclaiming disk: `consolidation.maintain`

`longterm_forget` (and `longterm_forget_many`) sets a tombstone: the fact leaves recall at once, and its
bytes leave at the next maintenance pass. Nothing schedules one, and plugmem's own
trigger is off by default, so without this a memory only ever grows. Measured
on the engine at `dim: 768`:

| | snapshot |
|---|---|
| 1000 facts | 1278 KB |
| 1000 facts, 500 forgotten, no maintenance | 1278 KB |
| the same, after maintenance | **674 KB** |

A revision is not reclaimable by any setting: `longterm_revise` closes the old
version and keeps it, because that is what answers "what was true then". Roughly
1 KB per fact, so a memory of ten thousand facts is about 13 MB.

## Which folder gets its own memory: `memory.project.*`

Two questions are asked, walking up from the folder pi was started in, and the
order between them is the whole of it:

1. **Does an ancestor already have a memory?** Then this folder uses it. That is
   what makes one memory serve a whole tree: bind the root of a monorepo and
   every package inside it inherits, until a package is given its own with
   `/longterm-new`, which then wins by being nearer.
2. **Does an ancestor look like a project root?** Only if the first question
   found nothing. This is the guess, and it is configurable because it is a
   guess.

| key | default | what it does |
|---|---|---|
| `project.markers` | `[".git"]` | names that make a folder a project root. An empty list switches guessing off: then only folders somebody asked for have a memory |
| `project.maxParents` | `16` | how many parent folders the search may climb. `0` looks at the working directory alone |

`.git` alone by default, on purpose. The list used to name every language's
manifest and got the granularity wrong in both directions at once: a package
inside a repository became a separate memory without telling you, and a folder with no
manifest got none at all. Add what this machine actually uses (`Cargo.toml`,
`go.mod`, `pyproject.toml`) and nothing you did not ask for appears.

Your **home directory is never a project by marker**, whatever is in it. People
keep a `.git` in `~` for their dotfiles, and without this rule every session
outside a real project files its facts under a project named after your login. A
memory you bound there yourself with `/longterm-new` is still honoured: the rule
is about guessing, and you were not guessing.

The search starts from the folder's **real path**, symlinks resolved. Reached
through a link and through its own name, one directory would otherwise be two
projects with two memories, neither aware of the other.

### A folder with no memory: `/longterm-new`

Nothing is stored about that folder as `scope: "project"`, and the model is told
so: what it writes as `scope: "user"` goes to the shared memory and is shown in
every other project, so only facts about *you* belong there. If the folder
deserves a memory of its own, run `/longterm-new`. It asks you to confirm, mints
an empty memory bound to exactly that folder, and reopens the memory in place, with
no restart. Whatever the folder was inheriting is untouched and keeps serving
everything else under it.

## Cross-project questions: `memory.crossProject.enabled`

Default `true`. Lets the model ask another project's memory by name: "how did I do auth
in api?". The other project's database is opened read-only, which
takes a shared lock, so the question is safe to ask while somebody is working in
that project.

## The engine: `memory.plugmemConfig`

Everything about the storage engine (the embedder, retrieval weights,
maintenance) is configured in **plugmem's own `config.toml`**, not here. This
setting says only where that file is:

```
<agentDir>/extensions/pi-accumemory/memory/config.toml
```

`null` (the default) means exactly that path. A relative path is read from the
extension's own directory, not from wherever you happened to start Pi; a leading
`~` is your home directory.

The file is **yours**. The extension writes it once, when it is not there, and
never edits it again, so:

- delete it to get the defaults back on the next start;
- if the path you named holds no file, one is written **there** and you are told
  so, because a path pointing at nothing is a typo far more often than a request;
- what it contains is plugmem's business. It validates the file and reports what
  it did not understand.

### Everything that file takes

The extension writes a short file with the handful of keys needed to get
started. It is not the limit of what you may put there: **every key plugmem
takes works, whether or not the generated file mentions it.** The full list,
each with its type, default and one line of what it is for, is
[`config.example.toml`](https://github.com/m62624/plugmem/blob/main/config.example.toml)
in plugmem's repository. Copy the sections you want into your file and uncomment
what you change.

| section | what it governs |
|---|---|
| `[engine]` | vector width, size limits, what a write may hold |
| `[embedder]` | the embedding service: endpoint, model, key variable, behaviour when it is down |
| `[recall]` | how a question is answered: source weights, the recency discount and its half-life, graph depth and decay, the duplicate threshold |
| `[index]` | the vector index: HNSW build width, and the vector count at which it stops scanning flat and builds the graph |
| `[maintenance]` | reclaiming the bytes of forgotten facts, and what triggers a pass |

**Five keys are read by nothing here**, so filling them in is wasted effort.
`[database].path` and `[workspace].dir` do not decide where anything lives:
every memory is opened by an explicit path, one database per project plus the
shared one, and moving `config.toml` itself does not move them.
`[workspace].max_open` and `[workspace].idle_timeout_ms` configure a pool this
extension does not use; it opens each database itself. `[server].workers` is
read only by plugmem's MCP server, which is not what runs here.

## The embedder: in `config.toml`

**Off by default, and recommended on.** Off, memory answers only when the
question happens to share words with the stored fact: there is no stemming, so a
fact written as `cache disabled: race with the warmup task` is not found by
"why is caching turned off here". With an embedder it is.

Recommended setup, with [Ollama](https://ollama.com) running locally:

```sh
ollama pull bge-m3
```

```toml
[engine]
dim = 1024

[embedder]
enabled = true
url = "http://localhost:11434/v1/embeddings"
model = "bge-m3"
on_error = "degrade"
```

Pick a **multilingual** model if you work in more than one language. One memory
holds them all, and an English-only model (`nomic-embed-text`) answers poorly on
anything else. `multilingual-e5-small` is a lighter alternative to `bge-m3`.

`api_key_env` is the **name of an environment variable** holding a bearer token,
never the token itself. Nothing in this extension ever stores a credential: it
does not even read that file.

### When the embedding service is down: `on_error`

`degrade` (what the generated file sets) keeps the memory working through an
outage: the fact is stored and the question is answered **without** the vector,
and the embedder suspends itself so the next call does not pay the same timeout
again. It retries by itself, and the facts written meanwhile get their vectors at
the next start, or from `/longterm-reembed`.

`fail` refuses the call instead. Nothing is damaged and nothing is lost, but the
model is told the memory would not answer, and it is told to pass that on to you
rather than retry.

`/longterm-status` says which of the three states the embedder is in right now:
none configured, answering, or not answering.

### Changing the model: handled for you

Vectors from two different models are not comparable, so plugmem refuses to mix
them. What that looks like, measured against the engine:

| | |
|---|---|
| opening the database | works |
| a lookup or a save **with text** | fails: `vector space mismatch` |
| tag/graph lookups, listing, exporting, forgetting | keep working |

Nothing is lost and nothing is silently wrong, but the two things this
extension is built on stop, and you would only find out at the first lookup.

So `memory.autoReembed` is **on by default** and the extension repairs this
itself:

- at session start it checks the shared memory and this project's, and rebuilds
  whichever is out of step before anything asks a question;
- another project's memory is repaired the moment a cross-project question
  needs it: a read-only handle cannot rebuild itself, so this takes the writer
  lock briefly and says so plainly if somebody else is holding it;
- switching the embedder **on** over an older memory is caught too. That case
  errors at nothing at all: the old facts simply have no vectors, so
  meaning-based recall would answer from a fraction of the memory and say
  nothing about it.

Set `memory.autoReembed: false` to be told instead of repaired; the rebuild is then one
`/longterm-reembed` away. That command always walks **every** memory in the
workspace, because a half-rebuilt workspace answers from two different vector spaces
with nothing reporting it.

A rebuild is resumable: each fact is replaced in place, so an interrupted one
keeps what it finished and running it again completes the job.

### `space_id`

Left out (the default) plugmem derives the space from the model name, so
changing the model changes the space, which is what you want. Pin it to a name
of your own only when you are swapping endpoints or aliases for the **same**
model and do not want a rebuild.

## Instructions you can extend

The extension ships instruction text in
`<agentDir>/extensions/pi-accumemory/instructions/defaults/`. Those files are
**ours** and are rewritten whenever they differ from the shipped version. Edit
one and your change disappears on the next upgrade.

To add your own, create the matching file under `instructions/append/`. It is
never overwritten and never merged away:

| key | what it covers |
|---|---|
| `memory` | when to ask the memory, and when to save |
| `placement` | what belongs in the project memory and what in the shared one |
| `consolidation` | how the background pass curates |
| `notes` | when a note beats a fact |
| `tags` | tag conventions |
| `secrets` | what must never be stored |

A project can carry its own, committed with the code:

```
<projectRoot>/.pi/pi-accumemory/instructions/append/<key>.md
```

**A project file replaces the global one for that key. They are not merged.**
Read that twice: create a project `memory.md` and your global `memory.md`
silently stops applying. If you want both, paste the global text in.

`secrets` is special. It is always included, always composed **last**, below
everything you added, so an append can make it stricter (your internal URLs,
client names) but never weaker.

## Commands

| command | what it does |
|---|---|
| `/longterm-status` | which project this is, where the memory lives, what projects are registered |
| `/longterm-inspect` | search, inspect, tag-filter, and batch-delete stored facts in a responsive terminal window |
| `/longterm-new` | give this folder a memory of its own — see above |
| `/longterm-rebind` | give this folder a memory that already exists — see below |
| `/longterm-consolidate` | run the background pass now instead of waiting for a quiet period |
| `/longterm-reembed` | rebuild every stored vector after an embedder change |

## Moving your memory to another machine

Copy two directories out of `<agentDir>/extensions/pi-accumemory/`: `memory/`
(the databases and plugmem's `config.toml`) and `notes/` (the long note bodies).
Copy them while pi is not running, or you will take a journal that has not been
checkpointed. The database files themselves are portable as they are: plugmem
writes a snapshot that is byte-identical on Linux, macOS, Windows and every
build in between, so there is nothing to convert and no export step.

What does **not** survive the trip is the binding. A project's memory is found
by the project's absolute path, and on the other machine that path is different:
`/home/you/code/app` is `/Users/you/code/app` or `C:/code/app`. The router finds
no route, mints a new empty memory, and the one you carried over sits there
intact and unreachable.

`/longterm-rebind` is how you attach it. It lists every memory the workspace
holds: id, folder name, how many facts, and the full path each one is bound to.
The ones that need attention come first: memories bound to nothing, then
memories whose folder does not exist on this machine. You pick yours, confirm
twice (once for "this memory here", once for "and the current one no longer"),
and the memory is reopened on the spot. No restart.

Two rules it will not bend:

- **The folder's current memory has to be empty.** If it already holds facts,
  binding another one would mean two sets of facts about one codebase with no
  way to tell them apart afterwards, so it refuses and says how many facts are
  in the way. Nothing is ever merged.
- **Nothing is guessed.** No matching by folder name, no git remote. A wrong
  guess joins two memories, and joined memories do not come apart. You are shown
  what there is; the choice is yours.

The memory that was displaced stays on disk, bound to nothing. You are asked
whether to delete it (database, sidecars, notes and all), and if you say no it
keeps showing up in the list, marked `NOT BOUND` with the path it used to have,
so you can bind or delete it later.

## Switching it all off

```json
{ "memory": { "enabled": false } }
```

No tools are registered, nothing is added to the prompt, and no database is
opened. The stored memory is untouched and comes back when you switch it on.

## Looking at the data yourself

The databases are plain plugmem files:

```
<agentDir>/extensions/pi-accumemory/memory/db/common.plugmem
<agentDir>/extensions/pi-accumemory/memory/db/p_<projectId>.plugmem
```

With `plugmem-cli` installed you can read them directly, and it opens read-only, so
this is safe while pi is running:

```sh
plugmem-cli --workspace <agentDir>/extensions/pi-accumemory/memory \
            --config  <agentDir>/extensions/pi-accumemory/memory/config.toml \
            workspace list
```

The CLI is for you, not for the extension: the runtime uses the `plugmem` npm
package directly.
