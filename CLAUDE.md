# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**omni-teams(전지적 팀즈 시점)** is a project management agent that collects unstructured natural-language conversations from Microsoft Teams (chat, files, posts) and transforms them in real-time into a versioned **ontology**—a structured knowledge graph stored as Markdown files in Git.

The core idea: teams keep using Teams naturally; the agent silently extracts decisions, task assignments, schedules, and issues, committing them as structured Markdown to a Git repo. All project memory is preserved and queryable.

## Repository Structure

```
omni-teams/
├── agent/          # Node.js layer (ESM, main: index.js)
└── api/            # Python agent server
```

The `agent/` package (`omni-teams-agent`) is ESM (`"type": "module"`). The `api/` directory is Python (LangGraph-based agent logic).

## Tech Stack

| Layer | Technology |
|---|---|
| Agent framework | LangGraph (Python) |
| Vector DB / semantic search | Qdrant (Graph RAG + SPARQL) |
| Ontology storage | Git repo — Markdown files |
| Long-term history | RDBMS (commits older than 1 year) |
| Message ingestion | Power Automate → REST API |
| Message queue | SQS (under evaluation) |
| LLM | Claude / GPT via API |

## Agent Architecture

Four agents operate in a pipeline:

1. **Orchestrator** — classifies incoming Teams message batches into event types: `NEW_TASK`, `UPDATE_TASK`, `ISSUE`, `QUERY`, `REPORT`, `SCHEDULE`
2. **CRUD Agent** — applies writes to the ontology (creates/updates Markdown files, commits)
3. **Query Agent** — reads ontology via Graph RAG, `git blame`, `git log`, or RDBMS for historical queries
4. **Report Agent** — aggregates a date range of commits/diffs into a structured weekly report Markdown

Agent tools:
```python
tools = [BashTool(), SPARQLQueryTool(), GraphRAGSearchTool()]
```

## Ontology File Conventions

### Folder layout (max 3 depth)
```
00_BASE/        # Project base info and term definitions
01_PERSON/      # Member profiles, roles, task history
02_ORGANIZATION/
03_BUSINESS/    # Business rules, policies, decision history
04_WBS/         # Work breakdown by feature
05_ISSUE/       # Issues, linked to WBS entries
reports/        # Auto-generated weekly reports
```

### Markdown frontmatter
Every ontology file uses YAML frontmatter:
```markdown
---
id: feature/robot-list-print
type: WBS
owner: BBB
created_by: AAA
created_at: 2026-04-30
due_date: 2026-04-30
status: in_progress   # pending | in_progress | done
tags: [robot, feature, backend]
related: [01_PERSON/BBB.md, 03_BUSINESS/robot-policy.md]
---
```

- Body contains only the **current state** (single source of truth)
- Incomplete fields are marked `보충필요`
- Historical changes are tracked via `git blame` / `git log -p`

### Commit message conventions
Commits use semantic tags for downstream querying:
```
[ASSIGN]    # New task assignment
[REASSIGN]  # Ownership change
[ISSUE]     # Issue raised
[RESOLVE]   # Issue resolved
[UPDATE]    # General field update
[REPORT]    # Weekly report generated
```

Example: `[ASSIGN] Add Robot List print feature, assigned to BBB by AAA, due 2026-04-30`

## History Query Strategy

| Time range | Tool |
|---|---|
| Recent / current | `git blame <file>` |
| Within 1 year (detailed) | `git log -p -- <file>` |
| Older than 1 year | RDBMS query |

## Data Flow

```
Teams → Power Automate → REST API → Python Agent Server
                                          │
                           ┌─────────────┼─────────────┐
                        LangGraph      Qdrant         Git repo
                        (agents)     (Graph RAG)    (MD files)
                           │            │               │
                         LLM API     SPARQL         git blame
                           │                         git log
                         RDBMS
                       (long-term)
```

Message batching strategy is configurable per channel: by read-receipts, by mention/reply thread, by hourly window, or custom.
