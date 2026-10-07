# Domain docs

## Layout

This is a single-context repository:

- `CONTEXT.md` at the root: domain terminology and context.
- `docs/adr/`: architectural decisions.

## Consumer rules

Before exploring the codebase, read `CONTEXT.md` and ADRs relevant to
the area being changed.

If these files do not exist, proceed silently. Do not suggest creating
them upfront. The domain-modeling skill creates them lazily when
terminology or decisions are resolved.

Use the vocabulary defined in `CONTEXT.md` in issues, proposals,
hypotheses, and tests. Reconsider unfamiliar terminology or note a
real glossary gap for domain-modeling.

If a proposal contradicts an ADR, explicitly identify the ADR and
explain why its decision should be reconsidered.
