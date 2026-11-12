# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/cpibia/tokenwise/security/advisories/new).

Include what an attacker could do, the steps to reproduce it and the Claude Code version. You will get an answer within a week.

## Scope

tokenwise runs inside Claude Code with the permissions of a plugin. It sends request text to Anthropic through Claude Code's own client, writes a journal under `~/.claude/tokenwise/`, and changes the model and effort of requests. Reports about any of these are in scope, in particular:

- data leaving the machine other than through the classifier call described in the README;
- the journal being written outside its folder, or with content it should not hold;
- a request text that makes tokenwise run a command or change settings beyond model and effort.
