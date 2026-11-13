# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-11-13

### Added

- `/tokenwise eval seed` and `/tokenwise eval`: label past requests from the journal and measure the classifier against them, with exact and within-one-tier accuracy and the direction of its errors.

### Changed

- The journal is one file per session and day (`<date>.<session>.jsonl`), so sessions running side by side no longer overwrite each other's lines.
- A short go-ahead such as "ok" keeps the previous level only when the last reply asked or proposed something; after finished work it is assessed like any other request.

- The classifier's scale now counts valuations, decisions with money at stake and messages to clients or management as level 5, and a behaviour that differs from what was expected as level 6, and sizes work without code by the cost of a wrong answer. On a hand-labelled set this cut the serious requests sized too low from 15 of 35 to 10.

### Fixed

- The first working request of a session now runs on its tier's level when that is lighter than the session's model (for example Sonnet on a session opened on Opus), and later work returns to that level after a light request on Haiku.
- Work that needs less than the model in use moves to its tier's model while the context is under 40k tokens, instead of only lowering the effort.

## [1.0.0] - 2026-11-12

### Added

- Classifier that places every typed request on an eight-tier scale, from Haiku 5.5 at low effort to Fable 5.2.
- Effort that follows the tier on the model in use, rising at once and coming down after two lighter requests.
- Light requests on Haiku while the context is under 100k tokens, with an automatic return to the session's model.
- A question before switching above the session's model, with the cost of the switch.
- Escalation of at least one tier when a result has to be redone.
- Offer to clear or compact when a new task arrives on a large context or after an hour away.
- Sizing of generic subagents from their brief.
- Local decision journal, the `/tokenwise` command and the `~` prefix to skip one request.
- English and Italian interface.

[Unreleased]: https://github.com/cpibia/tokenwise/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/cpibia/tokenwise/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/cpibia/tokenwise/releases/tag/v1.0.0
