# Contributing to tokenwise

Thanks for helping. tokenwise is small on purpose: one policy, one classifier prompt, a handful of hooks. Contributions that keep it that way are the easiest to merge.

## Reporting a misjudged request

The most useful report is a request that got the wrong tier. Open a [misjudged request issue](https://github.com/cpibia/tokenwise/issues/new?template=misjudged-request.yml) with:

- the journal line, from `~/.claude/tokenwise/<date>.jsonl` (remove anything private from the `text` and `cwd` fields);
- the tier you expected, and why;
- your "Your work and tools" option, if you set one.

## Reporting a bug

Open a [bug report](https://github.com/cpibia/tokenwise/issues/new?template=bug-report.yml) with your Claude Code version (`claude --version`), what you did, what you expected and what happened. Run `/tokenwise` and include its output.

## Development setup

You need Claude Code. There is nothing to install: Claude Code runs and type-checks the hooks itself.

```
git clone https://github.com/cpibia/tokenwise.git
cd tokenwise
claude --plugin-dir .
```

Before opening a pull request:

```
claude plugin validate .
claude plugin test .
```

## Where things are

| File | What it holds |
| ---- | ------------- |
| `hooks/policy.ts` | the decisions: which level a request gets, when to ask, when to offer a clean start. Pure functions, no I/O |
| `hooks/tiers.ts` | the tier scale and the effort each model needs for each tier |
| `hooks/assessor.ts` | the classifier prompt and the parsing of its answer |
| `hooks/register.ts` | the Claude Code hooks that wire the policy to a session |
| `hooks/copy.ts` | every string shown to the user, in English and Italian |
| `hooks/journal.ts` | the local decision journal |

## Pull requests

- One change per pull request, with a test when it changes behaviour. Policy changes belong in `hooks/policy.test.ts`; a change to how a hook behaves belongs in `hooks/register.test.ts`.
- Follow the style of the file you touch: identifiers and comments in English, comments only where the code cannot say why.
- New user-facing strings go in `hooks/copy.ts`, in both languages.
- A change to the tier scale or to what it costs should say what data it is based on.
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
