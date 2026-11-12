# tokenwise

A Claude Code mod that spends tokens where the work needs them. Before each request it sizes the work, sets model and effort to match, raises the level when a result has to be redone, and offers a clean start when a new task arrives on top of a heavy conversation.

## Why

In long Claude Code sessions most of the cost is not the model you picked: it is the conversation being re-read on every step. A session that carries 300k tokens of context pays for those 300k tokens on each tool call, whichever model runs it. tokenwise works on both levers:

- **the right model and effort for each request**, so a rename does not run on the strongest model at high effort, and a hard diagnosis does not run on a light one;
- **a lighter context**, by offering `/clear` or `/compact` at the moments where dropping the history costs nothing: a new, unrelated task, or a return after the prompt cache has expired.

## What it does

**Sizes every request.** A small classifier call places the request on an eight-tier scale, from small talk to the hardest open problems:

| Tier | Level | For |
| ---- | ----- | --- |
| 1 | Haiku 5.5 · low | chat, greetings, questions about the conversation |
| 2 | Haiku 5.5 · medium | look up one fact or run one command and report it |
| 3 | Sonnet 5.5 · medium | mechanical steps: commit and push, rename, run an existing script |
| 4 | Sonnet 5.5 · high | everyday work with a clear scope |
| 5 | Opus 5.5 · medium | features, new scripts, deploys, production and client data |
| 6 | Opus 5.5 · high | diagnosis, irreversible operations, long unattended work |
| 7 | Opus 5.5 · xhigh | very long autonomous work, intermittent defects, architecture, audits |
| 8 | Fable 5.2 · high | only when tier 7 has failed or the problem is exceptionally hard |

**Adjusts effort on its own.** On the model in use, effort follows the tier with no question asked. It rises at once and comes down only after two lighter requests in a row, so a quick question in the middle of heavy work does not deflate the next step.

**Moves light requests to Haiku.** A question or a single command (tiers 1 and 2) runs on Haiku while the context is under 100k tokens, the band where Haiku 5.5 bills at its base rate. There, writing the context to Haiku's cache costs about what a cache read on Opus does, and the answer is 40 times cheaper. The next request that needs more goes back to the model you started with, without asking, and finds its cache still warm. In the middle of heavy work it waits for a second light request, as with effort; a redo never goes down.

**Asks before switching to a stronger model.** Going above the model you started with mid-conversation makes Claude re-read everything without the prompt cache, so tokenwise proposes it and tells you what it costs. On the first working request of a session the switch is cheap and it simply recommends the right level; when that would be Sonnet it also offers Opus for the whole session, since a preparatory first step is often followed by heavier work.

**Escalates on rework.** When you say the last result is wrong or has to be redone, the redo runs at least one tier above the level that produced it. Repeating a failed attempt at the same level rarely fixes it; this is also the only way the scale reaches Fable for ordinary work.

**Respects "keep".** Answer a model question with the level in use and tokenwise stops proposing a stronger model for that session, except to redo failed work. Effort still follows the work, up to that model's ceiling.

**Offers a clean start.** When the context is above a threshold (120k tokens by default) and the request starts unrelated work, or you come back after more than an hour and the cache has expired, it asks whether to clear or compact first. Either way your request is sent right after, in the lighter session.

**Sizes generic subagents.** `general-purpose`, `Explore`, `Plan` and `claude` subagents start without the conversation, so choosing their model costs nothing: tokenwise picks it from the brief, up to Opus · high. A model the session chose for a subagent is kept and only its effort is set. Subagent types that declare their own model are left alone.

**Keeps Claude informed.** When the model changes, the model name in the system prompt and in `Co-Authored-By` lines is corrected.

**Writes a journal.** Every decision is one line in `~/.claude/tokenwise/<date>.jsonl`, with the tier, the reason and the outcome, so you can check afterwards what it estimated and tune it.

## Install

At the prompt of a terminal session:

```
/plugin install tokenwise --marketplace cpibia/tokenwise
```

From a shell:

```
claude plugin install tokenwise --marketplace cpibia/tokenwise
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `cpibia/tokenwise`, then Add plugin.

To try it from a local folder without installing: `claude --plugin-dir /path/to/tokenwise`.

## Use

| Command | Effect |
| ------- | ------ |
| `/tokenwise` | shows whether it is on, the level in use and today's journal |
| `/tokenwise off` / `on` | turns it off or on for this session |
| `/tokenwise reset` | back to the session's own model and effort |
| `~ your request` | skips tokenwise for one request |

Picking a model with `/model` or an effort with `/effort` always wins: tokenwise drops its own choice as soon as it sees yours, and logs it as a sign the level was off.

## Options

In `/config`, under tokenwise:

| Option | Values | Default |
| ------ | ------ | ------- |
| Language | `auto`, `en`, `it` | `auto` follows the language Claude Code is set to |
| Classifier model | `sonnet`, `haiku` | `sonnet`; `haiku` costs about a twentieth and answers faster, at some cost in accuracy |
| Offer a clean start above | `off`, `80k`, `120k`, `160k` | `120k` |
| Your work and tools | free text, up to 1,000 characters | empty |

The last option is sent to the classifier with every request. A couple of lines such as "I build Laravel apps and deploy on Coolify; anything touching production or client data is serious work" make its estimates noticeably closer to how you work.

## What it costs

- **One classifier call per request you type and per generic subagent.** The instructions are about 2,000 characters, plus at most 1,500 characters of your request and 800 of the last reply: roughly 1,000 to 1,500 input tokens, and at most 300 output tokens. On Sonnet 5.5 at list prices that is about half a cent; on Haiku 5.5, a few hundredths of a cent. These figures come from the prompt's size, not from billing. On a subscription the calls count toward your usage limits.
- **A short wait before each request starts**, while the classifier answers: usually one or two seconds, never more than 20. If the call fails or times out, the request goes through unchanged.
- **No call at all** for bare confirmations ("ok", "go ahead", "sì, procedi") after substantial work: they continue at the level already set.

## Data

- **What is sent, and where.** For each request you type, the classifier call sends the request (first 1,500 characters), the end of the last reply (800 characters), a pending question if there is one, and your "Your work and tools" note. For a generic subagent it sends the subagent's description and brief. These calls go through Claude Code's own API client to Anthropic, the same destination as the rest of your session. Nothing is sent anywhere else.
- **What is stored, and where.** Only the local journal in `~/.claude/tokenwise/` (or under `$CLAUDE_CONFIG_DIR`). It is never uploaded.
- **What it changes.** The model and effort of your requests and of generic subagents, the model name in the system prompt and attribution lines, and, only after you choose it, a `/clear` or `/compact` followed by resending your request. It reads no files outside its journal and runs no shell commands.

## Limits

- **The mod API is early access.** Claude Code's function hooks may change between releases, and tokenwise may need an update when they do.
- **Interactive sessions only.** In `claude -p` and other runs with nobody to ask, it does nothing.
- **Managed organizations.** Where an organization manages Claude Code, some hooks do not run for plugins a person installs. Model and effort still change; the model name in the system prompt may not be corrected.
- **The classifier is a language model.** It can misjudge a request. Between two tiers it is told to pick the higher one, since too little means work to redo. The journal is there to check it.
- **The tier scale is written for Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.2.** When new models arrive, `TIERS` and the effort table in `hooks/tiers.ts` need updating. Tiers that use a model your plan does not include will not work.
- **The journal is never pruned.** One small file per day; each line holds the first 160 characters of a request and the working folder.

## Development

```
claude plugin validate .
claude plugin test .
```

The policy (`hooks/policy.ts`) is pure and covered by tests: tier escalation, effort hysteresis, the "keep" rule, fresh-start conditions, confirmation detection. `hooks/register.test.ts` plays the engine for the subagent path.

## License

MIT, see [LICENSE](LICENSE).
