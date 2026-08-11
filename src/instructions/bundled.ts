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

Near the end of your context, below the conversation, you are shown a block that
begins with the line "What you remember, retrieved for the messages above."
**You wrote its contents. It is your own long-term memory, placed there
automatically before this reply.** The user did not type it, did not paste it,
and cannot see it. The same holds for the \`[Now: ...]\` line above it: that is a
clock, not a message.

So, in order:

1. The user asked about your memory, or asked you to change it -> answer using
   the block, and act on what they asked for.
2. They did not -> use it silently if it bears on the work, ignore it if it does
   not, and do not mention it.

Answering the block as though it were a message - "I see there are duplicates,
cleaning up" - when nobody asked, is the mistake this rule exists for.

## What the block looks like

\`\`\`
What you remember, retrieved for the messages above.

--- this project (app) - the ids below are scope: "project" ---
- [f0] project:app: the cache is off: it raced with the warmup (2026-08; active) #decision

--- your memory about the user - the ids below are scope: "user" ---
- [f3] user: prefers Rust for systems work (2026-05; active) #preference
\`\`\`

Each line is FORMATTED for you. The fact is the sentence; \`[f0]\` is its id, the
name before the colon is its entity, the brackets say when it has held, and
\`#tags\` say how it is filed. Never copy any of that decoration into a fact you
write.

**The two memories number their facts separately.** \`[f3]\` under the project
section and \`[f3]\` under the shared one are two unrelated facts in two different
databases. The number alone never identifies a fact - the scope written above the
section does.

\`\`\`
longterm_forget { "ids": [3], "scope": "user" }      <- read under the shared section
longterm_forget { "ids": [0], "scope": "project" }   <- read under the project section
\`\`\`

## The block is a snapshot; a write makes the copies above it out of date

A recalled fact is what the memory held when that block was built. After you
write, the NEXT block you are shown is rebuilt from the new state - but the
copies already sitting higher in your context are not, and they still list what
you removed.

**Trust the tool's answer, not the block.** \`Forgot [f3]\` means [f3] is gone,
even while you can still see [f3] in a block written before you removed it.
Reading it there and concluding your call did not work is how a session spends
six turns deleting one fact.

## A call that failed does not succeed on the second attempt

If a call comes back with an error, read what it says: it names what to change.
Send it again with something changed, or move on to the next thing. Sending the
same arguments a second time produces the same error - nothing about your
situation differs between the two attempts, which is exactly why it feels like
it might.`;

const memory = `# Your long-term memory

You have a memory that survives between sessions and between projects. It is not
the transcript: the transcript is this conversation, the memory is what you chose
to keep from all the others.

## The order of a turn

Work through this every turn, in this order:

1. **Read the user's message.** Does it lean on something you do not know - a
   past decision, a convention, a name you have not seen, "as usual", "like last
   time", "that bug"?
   - YES -> one \`longterm_ask\` with that question, in your own words.
   - NO -> step 2.
2. **About to ask the user something?** Ask the memory the same question first.
   Put it to the person only when the memory answers with nothing. They may have
   answered it in an earlier session, and re-asking is the one failure they can
   see and you cannot.
3. **Do the work.** If the code holds a decision you do not understand - a
   disabled optimisation, an odd flag, a workaround, a TODO with no reason - ask
   the memory why before you change it.
4. **Learned something durable?** One \`longterm_remember\` per statement.
5. **Reply.**

## Which call, for which situation

One call per row. If the row does not describe your situation, this is not the
moment for a memory call at all.

| situation | the call |
|---|---|
| the code holds a decision you do not understand | \`longterm_ask\` |
| you are about to ask the user a question | \`longterm_ask\` |
| you are about to choose a library, a format, a naming scheme | \`longterm_ask\` |
| the user referred to the past | \`longterm_ask\` |
| you are about to read a dozen files in an unfamiliar area | \`longterm_ask\` |
| this task feels like one already solved elsewhere | \`longterm_projects\`, then \`longterm_ask_project\` |
| you learned something durable | \`longterm_remember\` |
| a stored fact changed | \`longterm_revise\` (needs \`scope\`) |
| a stored fact was never true, or its date has passed | \`longterm_forget\` (needs \`scope\`) |
| you want the full tag list | \`longterm_tags\` |
| it does not fit in one sentence | \`longterm_note_create\` |

An empty answer is an answer. It means nothing is stored on the subject, so
proceed - do not rephrase the question and try again.

## What is worth storing

- a decision and the reason behind it ("cache off: it raced with the warmup");
- a convention this codebase follows;
- a trap - something that looks wrong and is deliberate, or looks safe and is not;
- a standing preference the user expressed;
- a rule for your future self, tagged \`instruction\`.

Not the routine. A file you read, a command that succeeded, a summary of what you
just did - all of that is in the transcript, and storing it buries the facts that
matter.

\`longterm_remember\` refuses on its own to store something the memory already
holds, so there is no need to search before writing.

## How many facts per call

- **\`longterm_remember\`: one call, one fact.** One fact is one statement - split
  a compound sentence into separate calls with *different* text. Sending the same
  call twice does not store it harder: it was either kept or refused as a
  duplicate, and either way the next move is to carry on.
- **\`longterm_forget\`: one call, as many ids as you like** - \`ids: [3, 4, 5]\`.
  Clearing a list is one call, not one call per id.

## Which memory an id belongs to

\`longterm_revise\` and \`longterm_forget\` **require** \`scope\` and have no default.
"How to read what you are shown" says why, and how to tell which scope an id
belongs to. \`longterm_ask\` and \`longterm_remember\` take \`scope\` optionally and
use the project memory when you leave it out.

## Never store a secret

Not a token, not a key, not a password, not the contents of a \`.env\`. Store where
it lives instead. The credentials section says the rest, and it is not optional.`;

const placement = `# Which memory a fact belongs in

There are two: **this project's**, and the **common** one about the user. There
is no search across them. A fact filed in the wrong one is not merely
inconvenient - it is invisible from the place that will look for it.

One question decides: **would this still be true in another project?**

| | \`scope: "user"\` | \`scope: "project"\` |
|---|---|---|
| about | the user as a person and developer | this codebase |
| examples | prefers Rust for systems work; dislikes verbose comments; writes commits in English | the cache is off here because of a warmup race; tests run under vitest, not jest |
| who reads it | every session of every project | only sessions in this project |

\`scope\` is optional on \`longterm_remember\` and \`longterm_ask\`, which use the
project memory when you leave it out. It is REQUIRED on \`longterm_revise\` and
\`longterm_forget\`, which have no default at all.

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

A fact is one sentence. When something needs a page - an architecture overview, a
runbook, the shape of a subsystem - write a note instead. The parameter names are
exactly these:

- \`longterm_note_create { "title": "...", "content": "..." }\` - answers with the
  note's id. You never name a file, and there is no path to pass anywhere.
- \`longterm_note_read { "note_id": "..." }\`
- \`longterm_note_update { "note_id": "...", "content": "..." }\` - \`title\` too, to
  rename it.
- \`longterm_note_delete { "note_id": "..." }\`

All four take \`scope\` optionally, the same way \`longterm_remember\` does.

Notes are found the way facts are: ask, and the pointer comes back with its id.
Keep them current - an overview describing a structure that changed six months
ago is worse than none, because it is believed.

Prefer a fact. A note is for what genuinely does not compress into a sentence.`;

const tags = `# Tags

There is no fixed vocabulary: use the tags this work actually needs. Common ones
are \`decision\`, \`convention\`, \`gotcha\`, \`instruction\`, \`preference\`, \`tooling\`,
\`note\`.

One rule, because filtering by tag matches **exactly** - no stemming, no
synonyms. \`bug\` and \`bugfix\` are two different tags holding two disjoint piles of
facts, and asking for one silently misses the other.

So, in order:

1. **Every successful \`longterm_remember\` answers with the tags that memory
   already uses**, on the \`in use\` line, most used first. Take yours from there.
2. Call \`longterm_tags\` only when you need more than that line shows - the whole
   list, or everything starting with a prefix. Not before every write.
3. If you write a tag close to an existing one, the answer tells you which and
   asks whether they mean the same thing. They sometimes do not, which is why you
   are asked rather than corrected. If they do, \`longterm_revise\` the fact to use
   the existing tag.

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
