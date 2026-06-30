# cns-import-flights

A portable Claude skill that imports external flight histories into the NRG2fly
Charging Network Simulator and returns a shareable Demand-Calculator link.

## Install

Copy this `cns-import-flights/` directory into your Claude skills location (e.g.
a plugin's `skills/`, or `~/.claude/skills/`), or package it as a plugin and
install that. No access to the CNS codebase is required.

## Configure (once)

Provide the skill with:
- `base_url` — defaults to `https://cns.nrg2fly.nl`.
- `import_token` — the shared `CNS_IMPORT_TOKEN` secret (ask the CNS admin).

## Use

Point Claude at a flight file ("import these PH-GOV flights into the DC"). The
skill asks a few clarifying questions, interprets the file, posts it, and hands
back the `/s/<slug>` link.

## Contract

The skill's only output is normalized JSON (`schema.json`); the CNS server does
all resolution, trip-typing, aggregation and link creation. A new provider only
exercises this skill — never the server.
