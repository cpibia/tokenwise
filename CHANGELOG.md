# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/cpibia/tokenwise/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/cpibia/tokenwise/releases/tag/v1.0.0
