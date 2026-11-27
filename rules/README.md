# Repository rules

Keep architectural guidance in focused `.mdc` files here. Each file is Markdown
with YAML frontmatter containing a `description` and an `alwaysApply` boolean.
For scoped rules, set `alwaysApply: false` and provide comma-separated,
repository-relative `globs`. For repository-wide rules, set `alwaysApply: true`
and omit `globs`. Use `**` for all descendants of a directory. Include sibling
entry points explicitly when needed.

Root `AGENTS.md` tells coding agents to list the rule headers, follow the
descriptions that cover their files, and read a rule body when they make a
design decision in its area or a reviewer cites it. Write each `description` as
one sentence that states the required behavior, because it is what an agent reads
first. This directory is a repository convention: Cursor does not
automatically load it as `.cursor/rules/`, and the `.mdc` extension alone does not
make a tool apply a rule.

Greptile reads matching rule files through `.greptile/files.json` and receives
loading instructions from `.greptile/rules.md`. The rule body remains here as
the single source of truth. Repository configuration takes effect when the
files are available on the reviewed branch; local files alone are not visible
to the hosted reviewer.

When adding or changing a rule:

1. State the scope, required behavior, examples, exceptions, and review criteria.
2. Add its path to `.greptile/files.json`. Copy its `globs` into that entry's
   `scope` array, one pattern per element. For `alwaysApply: true`, omit `scope`.
3. Keep the rule's frontmatter and the Greptile scope synchronized. Verify that
   the scope covers representative files and excludes unrelated directories.
4. Keep detailed policy in the rule file instead of copying it into tool settings.

Product behavior is covered by
[`product-harness-responsibility.mdc`](product-harness-responsibility.mdc): routine
work belongs to the harness, and user-facing detail must support an outcome or a
real decision. This applies to orchestration as well as UI.

See the [Greptile file-reference documentation](https://www.greptile.com/docs/code-review/greptile-config-reference)
for the manifest format.

Background execution is covered by
[`sleep-aware-background-work.mdc`](sleep-aware-background-work.mdc): new or
expanded work must become quiet, use events and real scheduler deadlines, and
preserve recovery across transactions, drain, and restart. This rule covers
`server/src/index.ts` and the worker/producer paths in its scope. It does not
require unrelated legacy polling to be migrated in the same PR.

## Repository agent rules (HOM-777)

Moved verbatim from `AGENTS.md` on 2026-11-27. These rules remain binding;
read the matching topic before changing it. Repository policy precedence is unchanged.

### Scoped rule loading

`rules/*.mdc` holds the architecture rules that reviewers apply to a pull
request. Each file starts with a short header: `description` is a one-sentence
summary of the rule, `globs` lists the files it covers, and `alwaysApply: true`
means it covers the whole repository.

You do not need to read the rule bodies before every change. List the headers to
see which rules exist and what each one asks for:

```sh
grep -E '^(description|globs|alwaysApply):' rules/*.mdc
```

Write the change so that it satisfies the descriptions of the rules that cover
your files. Read the full body of a rule only in these cases:

- You are making a design decision in the area the rule covers, such as adding a
  module, a background worker, or persisted state.
- The description does not tell you whether your change complies.
- A reviewer cites the rule.

These rules supplement this file and any applicable nested `AGENTS.md`
instructions. See [`rules/README.md`](rules/README.md) for rule authoring and
Greptile setup.
