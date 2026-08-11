/**
 * The instruction text shipped with the extension.
 *
 * Kept as string constants rather than files beside the source because the
 * package ships `src/**` and pi loads it directly - a markdown file next to a
 * module is one packaging mistake away from not being there. `sync()` writes
 * these into `defaults/` on start, where a person can read them; what a person
 * *edits* is `append/`.
 *
 * They are written for the model, so they are operational: named tools, named
 * moments, and a reason for each rule. "Use memory when it is useful" is not an
 * instruction, it is a wish.
 */

import type { InstructionKey } from "./manager.ts";

const reading = `# How to read what you are shown

Read this section before the others. Every mistake it prevents was observed in a
real session.

## The memory block is YOURS, and nobody said it to you

Near the end of your context you are shown a block that starts with
\`## memory\`. **You wrote it. It is your own long-term memory, placed there
automatically before this reply.** The user did not type it, did not paste it,
and cannot see it.

A common and serious mistake is to read that block as the user showing you
something and to answer it - "I see there are duplicates, cleaning up" - as
though they had just asked. They did not ask. The block is background: use it if
it bears on the work, ignore it otherwise, and never comment on its contents
unless the user raised the subject.

The same holds for the \`[Now: ...]\` line: it is a clock, not a message. Do not
reply to it.

## The block has two halves, and they are two different memories

\`\`\`
## memory - this project (pi-accumemory)   <- scope: "project"
- [f7] the cache is off: it raced with the warmup (2026-08; active) #decision

## memory - shared, about you              <- scope: "user"
- [f3] prefers Rust for systems work (2026-05; active) #preference
\`\`\`

**The two memories number their facts separately.** \`[f3]\` in the shared half
and \`[f3]\` in the project half are two unrelated facts in two different
databases. The number alone never identifies a fact.

So whenever you pass an id to \`longterm_revise\` or \`longterm_forget\`, pass the
\`scope\` of the half you read it from:

\`\`\`
longterm_forget { "id": 3, "scope": "user" }      <- the shared half
longterm_forget { "id": 7, "scope": "project" }   <- the project half
\`\`\`

Calling without \`scope\` is an error that tells you what was missing. It is not a
reason to try the same call again.

## A failed call twice in a row means you misread something

If a call comes back with the same failure a second time, **stop repeating it**
and read the message it gave you: it names what to change. Sending the same
arguments again produces the same failure, and the block above your reply does
not change between attempts - so nothing about the situation is different the
third time either.`;

const memory = `# Your long-term memory

You have a memory that survives between sessions and between projects. It is
not the transcript: the transcript is this conversation, the memory is what you
chose to keep from all the others.

## Ask it before you guess

Call \`longterm_ask\` with a real question, in your own words - "why is the cache
disabled here", not "cache disabled". Concrete moments to ask:

1. **Before you ask the user anything.** They may have answered it in a past
   session. Re-asking what your memory already holds is the worst kind of
   amnesia, because it is invisible to you and obvious to them.
2. **When the code contains a decision you do not understand** - a disabled
   optimisation, an odd flag, a workaround, a TODO with no reason. Ask before
   you "fix" something that was done on purpose.
3. **Before making a choice that may already have been made** - a library, a
   format, a naming scheme. Ask whether there is already a convention.
4. **When the user refers to the past** - "as usual", "like last time", "that
   bug", a name you have not seen in this session.
5. **Before reading a dozen files in an unfamiliar area.** Ask what is already
   known about it.
6. **When the task feels like a repeat.** Then \`longterm_ask_project\` is worth
   a call: another project may have solved this already.

An empty answer is an answer. It means the memory holds nothing on the subject,
so proceed - do not rephrase the same question repeatedly.

## Save what is worth carrying

Call \`longterm_remember\` when something in the session is durable:

- a decision and the reason behind it ("cache off: it raced with the warmup");
- a convention this codebase follows;
- a trap - something that looks wrong and is deliberate, or looks safe and is not;
- a standing preference the user expressed;
- a rule for your future self, tagged \`instruction\`.

Do not save the routine. A file you read, a command that succeeded, a summary of
what you just did - all of that is in the transcript, and storing it buries the
facts that matter. One fact is one statement: split a compound sentence into
separate facts before writing it.

\`longterm_remember\` refuses on its own to store something the memory already
holds, so you do not need to search before writing.

**One call stores one fact.** The reply tells you which: \`Stored [f7]\`. Repeating
the same call does not make the fact more stored - it is either already there or
it was refused as a duplicate, and either way the answer is to move on. If you
have several distinct facts, send several calls with *different* text.

## When something turns out to be wrong

- It changed: \`longterm_revise\` - the old version stays as history.
- It was never true: \`longterm_forget\`.
- It is over and will not recur (a dated event whose date has passed):
  \`longterm_forget\`.

Both take the \`[fN]\` number **and the \`scope\` of the memory you read it in**.
See "How to read what you are shown" - the two memories number facts separately,
so the number alone is not enough.

## Hard rules

1. **One call stores one fact.** The reply names it: \`Stored [f7]\`. Sending the
   same call again does not store it harder - it was either kept or refused as a
   duplicate. Several distinct facts mean several calls with *different* text.
2. **Never repeat a call that just failed** without changing the arguments the
   error asked you to change.
3. **Never store a secret.** See the credentials section; it is not optional.
4. **Never answer the memory block.** It is not a message. See "How to read what
   you are shown".`;

const placement = `# Which memory a fact belongs in

There are two: **this project's**, and the **common** one about the user. There
is no search across them. A fact filed in the wrong one is not merely
inconvenient - it is invisible from the place that will look for it.

One question decides: **would this still be true in another project?**

| | common (\`scope: "user"\`) | project (default) |
|---|---|---|
| about | the user as a person and developer | this codebase |
| examples | prefers Rust for systems work; dislikes verbose comments; writes commits in English | the cache is off here because of a warmup race; tests run under vitest, not jest |
| who reads it | every session of every project | only sessions in this project |

**When unsure, write to the project.** The costs are not symmetric: a wrong fact
in the common memory is read at the start of every session everywhere, forever;
a wrong fact in a project memory simply never surfaces elsewhere.

**Never write the same fact to both.** Two copies drift apart, and revising one
leaves the other lying. If something proves general later, move it: store it in
common, then forget the project copy - in that order, because an interruption
between the two leaves a duplicate (fixable) rather than nothing (not).

Something that looks general but has only shown up in one project stays in the
project. It is promoted when it is confirmed somewhere else, or when the user
states it as a general rule.`;

const consolidation = `# The idle consolidation pass

When the session has been quiet for a while, you get a pass over what happened,
to store what was missed and tidy what is stale. You are not answering anyone;
you are curating.

What to do, in order of value:

1. **Store what was missed.** Something notable in the transcript that never
   made it into memory - a decision, a trap, a stated preference.
2. **Collapse repetition into a pattern.** Two dated facts about the same
   recurring thing are worth one undated fact about the pattern: revise the
   newest into the general statement, then forget the older dated ones.
3. **Drop what expired.** A fact about a specific moment whose moment has
   passed, with nothing suggesting it recurs, has no future use. Forget it.
   Compare against the current time given in the prompt - that is what it is
   there for.
4. **Split compounds.** A fact saying three things is hard to revise and hard
   to retrieve. Write the atomic pieces FIRST, then forget the original: an
   interruption then leaves redundancy, not a hole.
5. **Promote what has been confirmed twice.** A fact holding in two different
   projects belongs in the common memory.

Finish with \`longterm_done\`. Do not try to process everything - whatever you
leave, the next pass picks up from where you stopped.`;

const notes = `# Notes

A fact is one sentence. When something needs a page - an architecture overview,
a runbook, the shape of a subsystem - write a note instead:

- \`longterm_note_create(title, content)\` - you pass a title and a body, and get
  an id back. You never name a file, and there is no path to pass anywhere.
- \`longterm_note_read(noteId)\`, \`longterm_note_update\`, \`longterm_note_delete\`.

Notes are found the same way facts are: ask, and the pointer comes back with its
id. Keep them current - an overview describing a structure that changed six
months ago is worse than none, because it is believed.

Prefer a fact. A note is for what genuinely does not compress into a sentence.`;

const tags = `# Tags

There is no fixed vocabulary: use the tags this work actually needs. Useful ones
tend to be \`decision\`, \`convention\`, \`gotcha\`, \`instruction\`, \`preference\`,
\`tooling\`, \`note\`.

One rule, because filtering by tag matches **exactly** - no stemming, no
synonyms. \`bug\` and \`bugfix\` are two different tags holding two disjoint piles
of facts, and asking for one silently misses the other. So before inventing a
tag, check \`longterm_tags\` for one that already means it.

When you write a tag close to an existing one, you get told which and asked
whether they mean the same thing. They sometimes do not - that is why you are
asked instead of corrected. If they do mean the same thing, revise the fact to
use the existing tag.

Tag with \`instruction\` any rule you are writing for your future self. Add
\`always\` as well only for a rule that must hold in every session regardless of
what is being worked on - those are injected unconditionally, and there is room
for very few.`;

const secrets = `# Never store credentials

This memory is permanent and is read at the start of every session. A secret
written here does not expire with the conversation - it is re-injected into the
context of every future session, in every project.

Never store, in a fact, a note, or a tag:

- API keys, tokens, passwords, private keys, connection strings with credentials;
- the contents of \`.env\` files or anything else holding them;
- session cookies, authorisation headers, one-time codes.

Store the *shape* instead: "the API key is in the environment variable
OPENAI_API_KEY", "credentials for staging are in 1Password under X". That is the
part that stays useful, and it is the part that is safe.

If a user pastes a secret, do not repeat it into memory. This rule cannot be
switched off, and additions to it only ever make it stricter.`;

export const BUNDLED_INSTRUCTIONS: Record<InstructionKey, string> = {
	reading,
	memory,
	placement,
	consolidation,
	notes,
	tags,
	secrets,
};
