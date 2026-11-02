# Station

Station is an agent engine with a live 3D isometric office that shows it working. Each "line" is a set of AI agents
(designers, QA, a lister, a researcher, executives) that the engine runs itself, step by step, with every write jailed to
its own data folder, a spend guard on every model call and an e-stop. The office view (three.js) shows the agents at
their desks, their jobs, the ledger and the owner's approval queue.

This is a public snapshot of a private project. The internal planning and decision records, real prices and margins, and
deployment details are not included.

## What is in it

- `src/engine/` the engine: orchestrator, runtime, tools, spend guard, policy and locked rules, routines, requests.
- `src/server/` a local HTTP server (127.0.0.1 only) for the page and its API.
- `src/web/` the 3D office and its panels (three.js, no build step).
- `config/` agents, departments, lines, products, routines and the autonomy policy.
- `prompts/` agent and skill prompts.
- `tests/` the test suite (`node --test`).

## Running it

Requires Node.js 22 or later.

```
npm ci
npm test
```

The engine runs on a mock provider unless it is configured otherwise; the mock makes no model calls and spends nothing.
Settings come from environment variables only (`STATION_INSTANCE`, `STATION_PORT`, `STATION_PROVIDER`, and the provider
keys for a live instance); nothing in this repository holds a key.

## Licence and assets

See `NOTICE.md` and `ASSETS.md` for third-party code and asset licences.
