/**
 * What goes into the `config.toml` this extension writes.
 *
 * It writes one exactly once: when a workspace has none. After that the file is
 * the user's, and plugmem is the only thing that reads it. See `config-file.ts`
 * for who owns what.
 */

export const DEFAULT_PLUGMEM_CONFIG = `# plugmem's configuration for pi-accumemory's memories.
#
# This file is yours. pi-accumemory writes it once, when it is not there, and
# never edits it afterwards - so delete it to get these defaults back.
#
# Only the keys below are set; everything else stays at plugmem's own tuned
# defaults. This is not the limit of what you may put here: EVERY key plugmem
# takes works, whether or not it is named below. The full list, each with its
# type, default and what it is for:
#
#   https://github.com/m62624/plugmem/blob/main/config.example.toml
#
# What applies to every memory here: [engine] (vector width and size limits),
# [embedder] (the embedding service), [recall] (how a question is answered:
# source weights, recency discount, graph depth), [index] (the vector index) and
# [maintenance] (reclaiming the bytes of forgotten facts).
#
# Five keys are read by nothing here, so setting them is wasted effort:
#
#   [database].path            - every memory is opened by an explicit path (one
#   [workspace].dir              per project, plus the shared one), so neither of
#                                these decides where anything lives. Moving THIS
#                                file elsewhere does not move the databases.
#   [workspace].max_open       - the workspace pool is not used at all: this
#   [workspace].idle_timeout_ms  extension opens each database itself.
#   [server].workers           - read only by plugmem's MCP server.

[engine]
# Embedding width. It has to match what the model actually returns, and it is
# written into each database at creation - changing it later means a rebuild
# (/longterm-reembed), which the extension can also do by itself.
dim = 1024

[embedder]
# Off by default, so a machine with no embedding service still works. Switching
# it on is what lets a question worded differently from the stored fact find it
# at all, which is most of the point of this extension.
enabled = false
url = "http://localhost:11434/v1/embeddings"
model = "bge-m3"
# An unreachable provider stores and answers WITHOUT a vector rather than
# failing the call, and suspends itself until it can be reached again. The
# facts written meanwhile get their vectors on the next start, or from
# /longterm-reembed. Set to "fail" to be refused instead.
on_error = "degrade"
# The NAME of an environment variable holding the bearer token - never a token.
# api_key_env = "OPENAI_API_KEY"
`;
