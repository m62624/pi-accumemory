/**
 * The pages `longterm_about` reads out, one per call.
 *
 * The pattern is lifted from pi-telegram-manager's `telegram_bot_about`, and so
 * is the reason for it: a model asked "how does your memory work" answers from
 * whatever it can reconstruct, which is a plausible memory system rather than
 * this one. Here the answer is a document in this package.
 *
 * Two things it buys that the head instructions cannot.
 *
 * **Depth without cost.** The head is paid for on every single request of the
 * session. Anything that goes in it competes with the conversation for room, so
 * it has to stay short, and short is exactly what a local model handles badly -
 * it needs the worked example and the stated consequence, not the rule alone.
 * A page is paid for only by the turn that asks for it. So these are allowed to
 * be long, and they are.
 *
 * **One topic per call.** Handing over every page at once buries the one the
 * model needed under six it did not, which is the failure the head instructions
 * already have and cannot escape. Choosing a topic is a cheap decision -
 * the question names its own subject - and it means the answer arrives with
 * nothing else around it.
 *
 * These pages do not repeat the head. The head says what to DO, in the fewest
 * words that can carry it. These say how the thing WORKS, and why it behaves
 * the way it does when the short version was not enough.
 *
 * Bundled as strings rather than markdown files on disk, like
 * `instructions/bundled.ts` next door: nothing here is user-editable, nothing
 * has to be found at runtime, and a page can never be missing from an install.
 *
 * ASCII only, and no secrets - the same two rules as every other text this
 * extension ships. A test holds both.
 */

export const ABOUT_PAGES = {
	system: `# What this memory is

You are running with **pi-accumemory**, an extension for the Pi coding agent. It
gives you a memory that survives the end of a session, the end of a project, and
a compaction of your context.

Underneath is **plugmem**: a local database of facts, in a file on this machine.
No server, no cloud, no account. Nothing you store leaves the machine except to
the embedding endpoint the user configured, if they configured one.

## Two memories, not one

| memory | holds | read where |
|---|---|---|
| **project** | this codebase: its decisions, conventions, gotchas | only in this project |
| **user** | the person: how they work, what they prefer, what they use | in every project |

They are separate databases. They number their facts independently, so \`[f3]\`
exists in both and means two different things. This is the single most common
mistake made with this extension, and \`scopes\` is the page about it.

## What a fact is

One statement. Not a summary, not a paragraph, not a list. Each one carries:

- **text** - the statement itself
- **entity** - what it is about (a project, the user, a component)
- **tags** - an open vocabulary; the memory tells you which tags it already uses
- **time** - when it was recorded, and optionally from when until when it holds

The entity is not decoration. Duplicate detection is scoped by it: the engine
compares a new fact only against facts about the SAME entity. This extension
always fills one in for you, which is why \`longterm_remember\` can tell you
"this is already held" instead of quietly storing a seventh copy.

## Three ways a fact ends, and they are different

1. **revise** - it changed. The old version is CLOSED, not deleted. Asking what
   was true last March still answers with the old one. Use this for a fact whose
   value moved: a version number, a preferred tool, a deadline.
2. **forget** - it was wrong, or it has expired. The fact leaves search at once.
   Use this for something that should never have been stored, or that no longer
   describes anything.
3. **maintenance** - the extension reclaims the disk of forgotten facts while
   nothing else is happening. It never touches a revision or a live fact.

A revision is not a soft delete and a forget is not an edit. Choosing the wrong
one either loses history that answers questions later, or leaves a wrong fact
answering as though it were merely old.

## What you can count on

- Nothing you store is lost by a compaction. The block you are shown is rebuilt
  from the database on every request, not carried in the conversation.
- Fact numbers are never reused. A number that once meant something never comes
  to mean something else.
- Every call is on disk before it returns. A pass interrupted halfway keeps
  everything it did.

## Where this is

- Source: https://github.com/m62624/pi-accumemory
- Engine: https://github.com/m62624/plugmem

Do not describe this extension from memory - read the page. Other extensions
have memory tools too (\`planner_*\`, \`manager_*\`), they run on other databases,
and their behaviour is not this behaviour.`,

	turn: `# The order of a turn

This is the whole procedure. It is five steps and it does not branch.

## 1. Read the request. Is there something in it you do not know?

A decision, a convention, a name, "as usual", "like last time", "the way we
agreed" - anything that assumes shared history.

**Yes** -> one \`longterm_ask\` with that question, in your own words. **No** ->
step 2.

## 2. About to ask the user a question?

Ask the memory the same question first. The user has answered it before, and
being asked again is the thing this extension exists to stop.

Ask the person only when the memory answered with nothing.

## 3. Do the work.

## 4. Did you learn something that outlives this session?

One \`longterm_remember\` per statement. Not one call with three facts in it.

## 5. Answer.

---

## Which call, for which situation

One row, one call. This table is not a menu of good ideas; it is the mapping.

| situation | call |
|---|---|
| do not know why the code is the way it is | \`longterm_ask\` |
| about to ask the user something | \`longterm_ask\` |
| solved something like this in another project | \`longterm_projects\`, then \`longterm_ask_project\` |
| learned a durable fact | \`longterm_remember\` |
| a stored fact CHANGED | \`longterm_revise\` + \`scope\` |
| a stored fact was WRONG or expired | \`longterm_forget\` + \`scope\` |
| SEVERAL stored facts must go at once | \`longterm_forget_many\` + \`scope\` |
| want the full tag vocabulary | \`longterm_tags\` |
| does not fit in one sentence | \`longterm_note_create\` |
| do not understand how this memory works | \`longterm_about\` |

## A worked turn

> **User:** why is the cache off in the dev config?

Step 1 says: you do not know this, and it is project history.

    longterm_ask { question: "why is the cache disabled in dev" }

    ## memory
    - [f4] project:app: the dev cache is off: it raced with the warmup and served
      empty pages (2026-03; active) #decision #gotcha

Now answer from that, and cite it as something you know rather than something you
just looked up. You do not announce the lookup and you do not quote the block.

## A second worked turn

> **User:** from now on run the tests with npm run ci, not npm test

Step 1: nothing unknown. Step 3: nothing to build. Step 4: this outlives the
session, and it is about the PROJECT.

    longterm_remember { text: "tests are run with npm run ci, not npm test",
                        tags: ["convention"] }

    Stored as [f9] in the project memory (entity project:app, tags: convention).
    Tags in use here: decision(12) convention(5) gotcha(3)

One call, one fact, and the tags came from what the memory already uses.

## A third worked turn, where the answer is silence

> **User:** rename the handler to \`onSubmit\`.

Step 1: nothing unknown. Step 2: nothing to ask. Step 4: a rename is not durable
knowledge - it is in the code, and the code is the record.

No memory call at all. That is the correct outcome for most turns. Storing this
would leave a fact that goes stale the next time anyone renames anything.`,

	scopes: `# Scopes: which of the two memories

There are two databases and they number facts independently. \`[f3]\` exists in
both.

| scope | subject | lives |
|---|---|---|
| \`project\` | this codebase | here only |
| \`user\` | the person | in every project |
| \`both\` | reading from the two at once | never written to |

## A folder does not always have a project memory

One memory can cover a whole tree - a subfolder uses the memory of the project
above it - and some folders have none at all, because nothing marked them as a
project and nobody asked. There, \`scope: "project"\` has nowhere to go, and the
tools say so.

That is not an invitation to put the fact in \`user\` instead. The shared memory
is shown in EVERY project, so a fact about this codebase filed there is noise in
all the others, permanently. Put only what is true about the PERSON in \`user\`,
and tell them that \`/longterm-new\` gives this folder a memory of its own. It is
their command; you cannot run it.

## Where the argument is optional, and where it is not

- \`longterm_ask\` and \`longterm_remember\` - **optional**. Left out, it is
  \`project\`.
- \`longterm_revise\`, \`longterm_forget\` and \`longterm_forget_many\` -
  **required**, no default. They take fact ids, and an id without a scope names
  two different facts.

That second rule has cost real sessions: ten consecutive "fact 3 not found"
replies while the fact sat in the other memory, unreachable because the scope
defaulted.

**Read the id off the block.** The block is split into labelled sections and each
one states its own scope on its heading line. The section a number came from is
the scope that number belongs to.

## Choosing where to write

Ask one question: **would this still be true in a different codebase?**

- "the user prefers Rust over Go" -> \`user\`
- "this project builds with cargo" -> \`project\`
- "the user always wants tests before an implementation" -> \`user\`
- "the tests here need a running Postgres" -> \`project\`

**When unsure, choose \`project\`.** A wrong fact there is wrong in one place. A
wrong fact in the user memory is read at the start of every session of every
project, and it will be believed for months.

## \`both\` cannot be written to

It is a reading scope. A fact lives in exactly one memory; there is no operation
that puts it in two. Passing \`both\` to a write is refused, and the refusal is
not about this directory failing to be a project - it is about the scope.

## Facts that turn out to belong elsewhere

There is no move. Store it in the right memory and forget the copy in the wrong
one. Two calls, and the second one needs the scope of the memory it is in.

The idle consolidation pass does one version of this by itself: a fact confirmed
in two different projects is a candidate for the user memory. You do not have to
do that by hand.`,

	writing: `# Writing to memory

## What is worth storing

Durable, and not derivable from the repository.

**Store:**
- decisions and the reason behind them - "we dropped the queue because ordering
  mattered more than throughput"
- conventions - "commits are conventional, tests run with npm run ci"
- gotchas that cost time - "the integration tests need the VPN"
- what the user prefers, in general - "explanations before code"
- how systems here relate - "the billing service reads the user table directly"

**Do not store:**
- what a file says. The file is the record and it is right there.
- what the code structure is. It changes, and reading it is cheap.
- what happened in this conversation, unless it will matter in another one.
- anything a \`git log\` answers.
- **anything secret.** Not a token, not a key, not a password, not the contents
  of a \`.env\`. If a credential matters, store where it LIVES - "the API key is
  in the SOME_KEY environment variable" - and never the value.

The test: **would this still be worth knowing in three months, and would a
sensible person be unable to work it out from the repository?**

## One call, one fact

\`longterm_remember\` stores one statement. Three things learned means three
calls with three DIFFERENT texts.

Not: "the project uses Rust, tests run with cargo test, and CI is on GitHub
Actions". That is three facts in one, and none of them can be revised or
forgotten without destroying the other two.

Deleting works the other way round, and it is two tools rather than one
argument that changes shape: \`longterm_forget\` takes \`id: 3\`, and
\`longterm_forget_many\` takes \`ids: [3, 4, 5]\`. Deleting five facts is one call
of the second, not five of the first.

## When a write comes back refused

The engine compares a new fact against what it already holds about the same
entity, and refuses one that is already there. It names what it collided with.

That is not an error and it is not a call to retry. The fact is stored. Read
what it collided with:

- **it says the same thing** - done, move on. Do not rephrase and try again.
- **it says something different about the same subject** - the old one CHANGED:
  \`longterm_revise\` it, do not add a second.
- **it is genuinely a different fact that happens to read alike** - make the text
  say what actually distinguishes it, and store that.

A refusal answered by calling again with slightly different words is how a
memory ends up with six copies of one fact. It has happened; that is why the
guard is there.

## Revise, forget, and the difference

**revise** = the world moved. The old version is kept and closed, so a question
about what was true earlier still answers correctly. Version numbers, owners,
deadlines, preferences that shifted.

**forget** = it was never true, or nothing it describes exists any more. It
leaves search immediately.

Getting this backwards is quiet damage: forgetting what should have been revised
throws away history nothing can reconstruct, and revising what should have been
forgotten leaves a wrong statement answering as merely old.

## What you get back

Every successful write reports where the fact went, under what entity, with what
tags, and which tags this memory already uses. The last part is the tag
vocabulary - take your tags from it rather than inventing a synonym for a tag
that already exists.

The user may have configured their terminal to show less of that report. It
makes no difference to what YOU are told: you always get all of it.`,

	recall: `# How remembering finds anything

## The block

Before most requests you are shown a block of facts. You did not ask for it and
nobody said it to you - it is your own memory, retrieved automatically from the
current subject of the conversation.

Use it silently. Do not thank anyone for it, do not summarise it, do not answer
it. It is not a message.

It is a **snapshot**, rebuilt for the next request. After you write something,
the copies already above you in the context are out of date; the next block you
are shown is the correct one.

## What the search actually does

Four signals, fused:

- **text** - BM25, the words themselves
- **vectors** - meaning, if the user configured an embedder. Without one - or
  while an embedding service is down - a question phrased differently from the
  stored fact will not find it. \`longterm_about\` with \`current_settings\`
  says which of those is the case.
- **graph** - facts about entities linked to the ones you hit
- **time** - recent and currently-valid facts rank above closed ones

So \`longterm_ask\` is worth using with a real question in natural language, not
a keyword. "why is the cache off" beats "cache".

## Recall is not similarity, and this trips people up

**A recall always returns its best match, however weak.** Ask an empty-ish
question and you get whatever was least unrelated. A result is not evidence that
anything matching exists.

**The duplicate detector is a different mechanism.** It has thresholds, it is
scoped to one entity, and it answers with nothing when nothing is close. That is
the only mechanism in this extension whose silence means "there is nothing like
this".

Never use a recall to decide whether a fact is a duplicate. It will always
return something, and something always looks like a duplicate if you squint.
That is what the refusal from \`longterm_remember\` is for.

## Asking

\`longterm_ask\` when the block did not carry what you needed. It is a question,
not a search term, and it is worth asking before you ask the person anything.

\`longterm_projects\` then \`longterm_ask_project\` when you want how something
was solved in a DIFFERENT codebase. Two calls, in that order: the first tells you
which projects this memory knows about.

Asking the same question twice in one turn gets you the same answer twice. If
the memory did not have it the first time, it does not have it.

## Tags and the graph

Tags are an open vocabulary. There is no fixed list, and the memory is a worse
memory when the same idea is filed under \`decision\`, \`decisions\` and
\`choice\`.

**The tags this memory already uses come back with every successful write.** Take
them from there. Call \`longterm_tags\` only when you want the complete list or
a prefix search.

\`longterm_link\` connects two entities with a named relationship - "service A
depends on service B". That is what makes a search about A also surface what is
known about B. \`longterm_unlink\` ends a relationship without destroying the
answer to what was true while it held.

Notes are for what does not fit in a sentence: a design sketch, a procedure, a
long piece of reasoning. The fact stays one statement; the note holds the body.`,

	consolidation: `# What happens while nobody is typing

The memory tidies itself. This is why a fact you stored may look different, or
be gone, in a later session - nothing is broken, and it was not the user.

## When

After about thirty minutes of quiet, a pass runs on its own. The user can also
start one with \`/longterm-consolidate\`. The moment anyone types, the pass stops
where it is - every call it already made is on disk, so nothing is half-done.

## Two phases

**Phase one reads the transcript.** The part of the conversation nothing has
looked at yet. It stores what was missed, collapses repetitions into one
statement, splits a fact that turned out to be three, drops what has expired, and
promotes to the user memory anything confirmed in two different projects.

**Phase two reads the memory itself**, oldest facts first. This exists because
phase one only ever considers what was just discussed - a fact from six months
ago is never reconsidered, not because it is right but because nothing puts it in
front of anybody. So a window of the oldest entries is shown, and each gets one
question: does it still earn its place.

The window walks forward and wraps at the end, and it grows with the memory, so a
full circuit stays around a hundred passes whatever the memory holds.

**Most facts survive phase two, and that is the expected outcome.** Age is not a
reason to delete anything. Only a date that has passed, a genuine duplicate, or a
statement that is now false is.

## Then the disk

At the end of a pass that did something, forgotten facts have their bytes
reclaimed. Revisions are never touched, in any mode - what was true in March goes
on answering.

## If you are the one running a pass

You are not in a conversation. Nobody is waiting and there is no reply to write:
the only things that count are the memory calls you make. Describing a change is
not making one. When you have nothing left to do, call \`longterm_done\`.

Each result carries a note about the budget. A pass has a step limit, and it is
not a failure to reach it - the next pass resumes from the same place.`,

	settings: `# How this extension is configured

Everything lives in one \`settings.json\`. **Its exact path on this machine is
printed by the \`current_settings\` topic** - ask for that rather than describing
where it "usually" is, because the location is derived from the Pi agent
directory and differs between installations. That topic also prints where the
databases are, and the value every setting below currently has.

The file may not exist. That is not a fault: absent means every value is the
built-in default, and creating it with only the keys being changed is the normal
way to configure this.

An unknown key is reported as a warning and ignored; a value of the wrong type
stops the extension with the full dotted path in the message. That difference is
deliberate - a typo should not silently become a behaviour.

## You cannot change any of it from a conversation

**Read this before promising anything.** "Turn off the nudges", "make the block
bigger", "stop consolidating" - none of it takes effect from a chat, no matter
who asks.

Settings are read when the session starts. To change one, the user edits
\`settings.json\` and restarts Pi. Say what the setting does, say where it lives,
say a restart is needed. Never say "done" or "I have turned that off".

## What there is

**\`memory\`**
- \`enabled\` - the whole extension.
- \`output\` - how much of what a memory tool did is echoed to the USER's
  terminal: \`short\`, \`full\` or \`hidden\`. It never changes what you are told;
  you always get the full account. (Named \`writeOutput\` in older settings
  files, which still work.)
- \`recallTokenBudget\`, \`recallK\` - how large the block may be, and how many
  facts it may draw.
- \`graphDepth\` - how far a search follows entity links.
- \`manifest\` - a one-time summary of what the memory holds, at session start.

**\`memory.plugmemConfig\`** - where the storage engine's own \`config.toml\`
is. That file, not this one, configures the embedder (the endpoint, the model,
the vector width, the name of the environment variable holding a key) and
everything else the engine takes. This extension never reads it; plugmem does.
Whether an embedder is answering RIGHT NOW is on the \`current_settings\` page,
because it can change during a session.

**\`memory.autoReembed\`** - rebuild the stored vectors when they stop matching
the embedder, instead of failing at the first lookup.

**\`memory.refresh\`** - when the block is recomputed: after N tool calls, after
a compaction.

**\`memory.nudge\`** - the reminder that nothing has been stored in a while, and
how long it stays quiet afterwards.

**\`memory.consolidation\`** - the idle pass. \`quietMs\` before it starts,
\`maxSteps\` and \`maxNudges\` as its budget, \`maxTranscriptChars\` for how much
transcript one pass reads, \`promoteToCommon\`, \`review.enabled\` and
\`review.sampleSize\` for the second phase, \`habits.enabled\` and
\`habits.afterSessions\` for the third, \`maintain\` for reclaiming disk at the
end.

**\`memory.crossProject.enabled\`** - whether another project's memory may be
read from here at all.

**\`memory.instructions\`** - \`alwaysMax\` and \`alwaysMaxChars\`: how many
standing rules are shown, and how many characters of them. This one has teeth:
a rule tagged \`instruction\` + \`always\` that would not fit is REFUSED when you
try to store it, because those are pasted into the head of every request forever
and a rule nobody reads is worse than no rule.

**\`memory.notes.overviewMaxChars\`** and **\`memory.queryMaxChars\`** - size
limits on the note overview and on the text a recall is built from.

**\`timezone\`** - the zone behind the clock you are given.

## Instructions can be extended without forking anything

Files in the extension's \`append/\` directory are added to the built-in
instructions. A project's file REPLACES the global one for the same key rather
than merging with it - which is quiet, and is worth saying out loud when someone
asks why their global text stopped applying.

The rule about never storing a secret is composed LAST, below anything anyone
appended. An addition can make it stricter. Nothing can make it weaker.

## Moving the memory to another machine

Worth knowing, because the answer is short and the guesses are long.

The database files are portable exactly as they are: plugmem writes a snapshot
that is byte-identical on every platform, so there is nothing to export or
convert. Copy \`memory/\` and \`notes/\` from the extension directory (paths on
the \`current_settings\` page) while Pi is not running.

What does not travel is the BINDING. A project's memory is found by the
project's absolute path, and that path is different on the other machine, so a
copied memory arrives intact and unreachable - a new empty one is made instead.
The user reattaches it with \`/longterm-rebind\`, which lists every memory with
its size and the folder it belongs to, and binds the chosen one here.

You cannot do this. It is a command the user types, and it asks them to confirm
twice. It also refuses when this folder's memory already holds facts, because
binding another one there would merge two memories, and merged memories cannot
be separated again.`,
} as const;

export type AboutPageKey = keyof typeof ABOUT_PAGES;
