# cns-import-flights

A portable Claude skill that imports external flight histories into the NRG2fly Charging Network Simulator and returns a shareable Demand-Calculator link.

See `SKILL.md` for what it does and how it runs (clarify → interpret → post → report).

Install by copying this directory into a Claude skills location (e.g. `~/.claude/skills/`) or packaging it as a plugin — no access to the CNS codebase is required.

The skill's only output is normalized JSON (`schema.json`); the CNS server does all resolution, trip-typing, aggregation and link creation, so a new source format needs only a new skill, never a server change.
