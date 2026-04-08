---
name: wiki
description: Maintain the group's persistent wiki knowledge base — ingest one source at a time, answer from the compiled wiki, and run wiki lint passes.
allowed-tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch"]
---

# Persistent Wiki Maintenance

This group has a Karpathy-style wiki knowledge base for a personal domain. Treat it as a three-layer system:

1. **Raw sources** in `/workspace/group/sources/` are immutable originals.
2. **The wiki** in `/workspace/group/wiki/` is the maintained knowledge base.
3. **The schema** is defined by `/workspace/group/CLAUDE.md` and this skill.

Use this skill whenever the user wants to add knowledge, ask questions against accumulated notes, or run a health check on the wiki.

## Core rule: process one source at a time

If the user provides multiple files or points to a folder containing many files, do **not** read them all first. Work through them sequentially:

1. Select one source.
2. Read it carefully.
3. Discuss the takeaways with the user when appropriate.
4. Fully update the wiki for that source.
5. Update `wiki/index.md`.
6. Append a `wiki/log.md` entry.
7. Only then move to the next source.

Batch-reading many files and summarizing them together produces shallow wiki pages. Avoid that.

## Ingest

When ingesting a new source:

1. Preserve or place the original in `/workspace/group/sources/`.
2. Read the source directly. For plain text, transcripts, and books, use the full text whenever possible.
3. Update the wiki, which may include:
   - source summary pages
   - people pages
   - concept/theme pages
   - project or responsibility pages
   - comparison or synthesis pages
4. Add cross-links between related pages.
5. Update `wiki/index.md` so it reflects the current page set.
6. Append a dated entry to `wiki/log.md`.

Prefer updating existing durable pages over creating duplicate pages with slightly different names.

### URL sources

If the user provides a URL and the full document matters, do **not** rely on a summary-only fetch. Use bash to download the real source into `sources/` first when possible, for example:

```bash
curl -sLo /workspace/group/sources/source-name.html "<url>"
```

For normal webpages, `WebFetch` can help with quick inspection, but use a full download or browser extraction when the exact text matters for ingestion.

## Query

When answering from the wiki:

1. Read `wiki/index.md` first.
2. Open the most relevant wiki pages.
3. Synthesize an answer from the maintained wiki, citing page paths such as `wiki/topic-name.md`.
4. If the answer creates durable knowledge, add or update a wiki page when the user asks or when preserving it is clearly valuable.
5. When a query results in a durable write-back to the wiki, append a dated `query` entry to `wiki/log.md`.

Answer from the wiki first, then fall back to raw sources only when the wiki does not yet contain enough detail.

## Lint

During a wiki lint pass, look for:

- contradictions between pages
- stale claims superseded by newer sources
- orphan pages with weak linking
- concepts, people, or projects mentioned repeatedly without dedicated pages
- missing cross-references
- index drift (`wiki/index.md` missing important pages)
- log drift (`wiki/log.md` missing major ingests or maintenance work)

Report the findings clearly. Always append a dated `lint` entry to `wiki/log.md`, including findings and whether fixes were applied.
