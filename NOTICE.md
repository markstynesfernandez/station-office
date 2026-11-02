# NOTICE.md — Station

Station (this repository, `office-agents`) is the station's own engine and its 3D office view. It replaces the legacy
system the station ran on until cut-over: **StarNet** (androoAGI/starnet v0.13.2, by Andrew Sims, MIT licence), which
runs in a separate local folder.

## StarNet code

**No StarNet code is included in this repository.** StarNet's routing, verdict, budget, halt and event modules were
read to describe their behaviour (ENGINE-PLAN.md Appendix B), and the recommendation for each was "do not port". The
engine re-implements the behaviour it needs in its own code.

If a StarNet file is ever ported after all, its MIT notice is reproduced in full in this file, with the file name and
the version it came from, before the code is merged.

StarNet's name, logo, artwork and sprites are not licensed for this project and are not used anywhere in it, in the
product UI or in code identifiers. "StarNet" appears only in documents and import code that name it as the legacy
system the station is migrating from.

## The owner's own station code

Modules under `src/lib/legacy-readers/`, `src/engine/gates/`, `src/engine/lib/` and the prompt sources under
`prompts/` are ported from the owner's own station code in `Virtual-workers/station/` (owner-written, no third-party
code). Each ported file names its source; PORTED.md records the source file's sha256 at the moment of porting.

## Third-party packages and assets

Every dependency, tool and asset, with its licence, is listed in ASSETS.md.
