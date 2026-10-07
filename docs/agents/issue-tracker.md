# Issue tracker: GitHub

Issues and PRDs live in GitHub Issues for `dev-sergeev/pi-gigachat`.
Use the `gh` CLI from this repository; infer the target from `origin`.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --comments`.
- List: `gh issue list --state open --json number,title,body,labels`.
- Comment: `gh issue comment <number> --body-file <file>`.
- Add/remove labels: `gh issue edit <number> --add-label "..."` or
  `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

For multiline bodies, write the exact text to a temporary file and use
`--body-file`.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue with comments.

## Pull requests as a triage surface

PRs as a request surface: no.
