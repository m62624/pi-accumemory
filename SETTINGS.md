# Settings

Everything lives in one file:

```
<agentDir>/extensions/pi-accumemory/settings.json
```

`<agentDir>` is normally `~/.pi/agent`. The file is optional — with no file at
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
		"writeOutput": "short",
		"recallTokenBudget": 512,
		"recallK": 0,
		"graphDepth": null,
		"manifest": true,
		"queryMaxChars": 600,
		"refresh": {
			"afterToolCalls": 10,
			"onCompact": true,
			"askHintAfterIdleInferences": 2
		},
		"embedder": {
			"enabled": false,
			"url": "http://localhost:11434/v1/embeddings",
			"model": "bge-m3",
			"apiKeyEnv": null,
			"spaceId": null,
			"autoReembed": true,
			"dim": 1024
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
			"afterMessages": 25,
			"afterToolCalls": 40,
			"cooldownTurns": 15
		},
		"consolidation": {
			"enabled": true,
			"quietMs": 1800000,
			"maxSteps": 12,
			"maxNudges": 2,
			"maxTranscriptChars": 20000,
			"promoteToCommon": true,
			"review": {
				"enabled": true,
				"sampleSize": 12
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

## Reading — `memory.refresh.*`

These decide **when the memory block is recomputed**. Between those moments the
prompt tail is byte-identical, which is what keeps the backend's prefix cache
intact.

| key | default | what it does |
|---|---|---|
| `refresh.afterToolCalls` | `10` | tool calls before the block is rebuilt mid-loop, from what the model has just learned rather than from the original request. `0` disables it |
| `refresh.onCompact` | `true` | rebuild right after a compaction — the worst moment to hold a stale block, since the history it summarised is gone |
| `refresh.askHintAfterIdleInferences` | `2` | after this many replies with no tool call at all, add a line reminding the model it can *ask* its memory. `0` disables it |

A new user message always rebuilds the block. That is not a setting — it is the
definition of a topic change.

| key | default | what it does |
|---|---|---|
| `memory.recallTokenBudget` | `512` | how much of the context window one recall may spend |
| `memory.recallK` | `0` | maximum facts per recall; `0` leaves the engine's own default |
| `memory.graphDepth` | `null` | how far to follow entity links; `null` uses the engine's default |
| `memory.manifest` | `true` | the one-line inventory shown once at session start, so the model knows there is something to ask about |
| `memory.queryMaxChars` | `600` | ceiling on the recall query. Lexical retrieval degrades as terms pile up, and a pasted wall of text drowns the words that identify the question |
| `memory.writeOutput` | `"short"` | how much of a memory write is printed **in your terminal**. See below |

## What you see when a fact is stored — `memory.writeOutput`

This setting changes **only what you see**. The model is always told everything:
which memory the fact landed in, under which entity, with which tags, and which
tags that memory already uses. Each of those is something it cannot recover on
its own and needs later — the scope to address the fact at all (the two memories
number their facts separately), the entity because that is what the duplicate
guard compares against, and the tag vocabulary because filtering matches tags
exactly, so a second spelling splits the pile and neither half ever answers the
other's question.

| value | what the terminal shows |
|---|---|
| `"short"` (default) | one line: `Stored [f7] in this project (app).` |
| `"full"` | everything the model was told. Useful while you are tuning tags or watching what lands where |
| `"hidden"` | nothing at all |


## Writing — `memory.nudge.*`

There is **no** automatic "save a summary of every turn". The model stores what
it judges durable; this is only the reminder that it has not stored anything in
a while.

| key | default | what it does |
|---|---|---|
| `nudge.enabled` | `true` | switches the reminder off entirely |
| `nudge.afterMessages` | `25` | messages with nothing stored before it appears |
| `nudge.afterToolCalls` | `40` | tool calls with nothing stored before it appears. Separate from the message count because an agentic run grows in tool calls without growing in messages |
| `nudge.cooldownTurns` | `15` | turns of silence after it fires. Without this it repeats every turn until something is written, which is how a hint becomes nagging the model learns to skip |

## The background pass — `memory.consolidation.*`

When the session has been quiet for a while, a pass re-reads the transcript pi
already wrote to disk and curates the memory from it: storing what was missed,
collapsing repeated dated facts into one undated pattern, and dropping what has
expired. It yields the instant you type, and everything it had decided by then
is already saved.

| key | default | what it does |
|---|---|---|
| `consolidation.enabled` | `true` | switches the pass off. Memory still works; only what the model saved itself is kept |
| `consolidation.quietMs` | `1800000` (30 min) | silence before a pass starts. A boundary meaning "work has stopped", not a budget |
| `consolidation.maxSteps` | `12` | tool calls before the pass is told to wrap up. This bounds a *confused* pass, not a busy one — whatever is left is picked up by the next pass from the same place |
| `consolidation.maxNudges` | `2` | how many times a pass that produced no action is nudged before being abandoned |
| `consolidation.maxTranscriptChars` | `20000` | how much transcript one pass reads. A cursor records how far it got, so a long session is digested by several small passes |
| `consolidation.promoteToCommon` | `true` | lets the pass move a fact confirmed in several projects into the shared memory |
| `consolidation.review.enabled` | `true` | the pass's **second phase**: re-reading the oldest stored facts. See below |
| `consolidation.review.sampleSize` | `12` | how many old facts one pass looks at, per memory |
| `consolidation.maintain` | `true` | reclaim the disk of forgotten facts at the end of a pass |

## The second phase — `consolidation.review.*`

The first phase reads the transcript, so it only ever weighs what was just
discussed. That leaves a gap nothing else covers: a fact learned six months ago
and never mentioned since is never reconsidered — not because it is still true,
but because nothing puts it in front of anybody.

So a pass has a second phase. It shows the model a window of the **oldest**
stored facts and asks one question of each: does this still earn its place. The
window walks forward every pass and wraps at the end, so the whole memory is
covered over time and nothing is shown twice in a row.

It runs even when the transcript has nothing new — an idle machine is exactly
when there is time for it — and it is a second agent run with its own step
budget, so the transcript phase cannot eat the budget before it starts.

Nothing here deletes on a rule. The model decides; a fact is dropped only when
its date has passed, it duplicates another, or it is contradicted. "Old" is not
a reason, and the instruction says so.

## Reclaiming disk — `consolidation.maintain`

`longterm_forget` sets a tombstone: the fact leaves recall at once, and its
bytes leave at the next maintenance pass. Nothing schedules one — plugmem's own
trigger is off by default — so without this a memory only ever grows. Measured
on the engine at `dim: 768`:

| | snapshot |
|---|---|
| 1000 facts | 1278 KB |
| 1000 facts, 500 forgotten, no maintenance | 1278 KB |
| the same, after maintenance | **674 KB** |

A revision is not reclaimable by any setting: `longterm_revise` closes the old
version and keeps it, because that is what answers "what was true then". Roughly
1 KB per fact, so a memory of ten thousand facts is about 13 MB.

## Cross-project questions — `memory.crossProject.enabled`

Default `true`. Lets the model ask another project's memory — "how did I do auth
in api?" — by name. The other project's database is opened read-only, which
takes a shared lock, so the question is safe to ask while somebody is working in
that project.

## The embedder — `memory.embedder.*`

**Off by default, and recommended on.** Off, memory answers only when the
question happens to share words with the stored fact: there is no stemming, so a
fact written as `cache disabled: race with the warmup task` is not found by
"why is caching turned off here". With an embedder it is.

Recommended setup, with [Ollama](https://ollama.com) running locally:

```sh
ollama pull bge-m3
```

```json
{
	"memory": {
		"embedder": {
			"enabled": true,
			"url": "http://localhost:11434/v1/embeddings",
			"model": "bge-m3",
			"dim": 1024
		}
	}
}
```

Pick a **multilingual** model if you work in more than one language — one memory
holds them all, and an English-only model (`nomic-embed-text`) answers poorly on
anything else. `multilingual-e5-small` is a lighter alternative to `bge-m3`.

`apiKeyEnv` is the **name of an environment variable** holding a bearer token,
never the token itself. Nothing in this extension ever stores a credential.

### Changing the model: handled for you

Vectors from two different models are not comparable, so plugmem refuses to mix
them. What that looks like, measured against the engine:

| | |
|---|---|
| opening the database | works |
| a lookup or a save **with text** | fails: `vector space mismatch` |
| tag/graph lookups, listing, exporting, forgetting | keep working |

Nothing is lost and nothing is silently wrong — but the two things this
extension is built on stop, and you would only find out at the first lookup.

So `autoReembed` is **on by default** and the extension repairs this itself:

- at session start it checks the shared memory and this project's, and rebuilds
  whichever is out of step before anything asks a question;
- another project's memory is repaired the moment a cross-project question
  needs it — a read-only handle cannot rebuild itself, so this takes the writer
  lock briefly and says so plainly if somebody else is holding it;
- switching the embedder **on** over an older memory is caught too. That case
  errors at nothing at all: the old facts simply have no vectors, so
  meaning-based recall would answer from a fraction of the memory and say
  nothing about it.

Set `autoReembed: false` to be told instead of repaired; the rebuild is then one
`/longterm-reembed` away. That command always walks **every** memory in the
workspace — a half-rebuilt workspace answers from two different vector spaces
with nothing reporting it.

A rebuild is resumable: each fact is replaced in place, so an interrupted one
keeps what it finished and running it again completes the job.

### `spaceId`

`null` (the default) lets plugmem derive the space from the model name — so
changing the model changes the space, which is what you want. Pin it to a name
of your own only when you are swapping endpoints or aliases for the **same**
model and do not want a rebuild.

## Instructions you can extend

The extension ships instruction text in
`<agentDir>/extensions/pi-accumemory/instructions/defaults/`. Those files are
**ours** and are rewritten whenever they differ from the shipped version — edit
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

**A project file replaces the global one for that key — they are not merged.**
Worth reading twice: create a project `memory.md` and your global `memory.md`
silently stops applying. If you want both, paste the global text in.

`secrets` is special. It is always included, always composed **last**, below
everything you added — so an append can make it stricter (your internal URLs,
client names) but never weaker.

## Commands

| command | what it does |
|---|---|
| `/longterm-status` | which project this is, where the memory lives, what projects are registered |
| `/longterm-consolidate` | run the background pass now instead of waiting for a quiet period |
| `/longterm-reembed` | rebuild every stored vector after an embedder change |

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

With `plugmem-cli` installed you can read them directly — it opens read-only, so
this is safe while pi is running:

```sh
plugmem-cli --workspace <agentDir>/extensions/pi-accumemory/memory \
            --config  <agentDir>/extensions/pi-accumemory/memory/config.toml \
            workspace list
```

The CLI is for you, not for the extension: the runtime uses the `plugmem` npm
package directly.
