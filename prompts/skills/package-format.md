## SKILL: ROOM 1 PACKAGE CONTRACT — DIGITAL (paths are relative to the line's project folder, room1-etsy)

Listing ID (`<id>`) = the brief's `id:` field. Every file for one listing lives under that ID. Never invent a new ID.

work/<id>/                          — scratch for this listing
  brief.md                          — the brief, frozen by the station at job start (read only; owner amendments in amendments/)
  set-v1/, set-v2/ …                — one deliverable SET per Designer pass; never change an earlier set
    files/<name>.png|.jpg           — the buyer's files, exactly as the product spec in products.json lists them (Designer)
    design.md                       — every image prompt used, what each file is for, an originality self-check (Designer)
    assets.json                     — optional {"assets":["font:anton"]}: anything else the set used (Designer); only assets in the station's register are allowed
    deliverables.json               — written by a station script (NOT an agent): each file's format, pixel size, bytes, sha256; the assets used
    deliverables.sha256             — written by the same script: the manifest's sha256 (QA DESIGN copies it into its record)
    originality.json                — written by a station script: the originality screen of design.md
  qa/design-pass1.json …            — QA DESIGN's record for EVERY pass (approved or revise)

outbox/<id>/                        — only what passed QA
  qa-design.json                    — written by QA DESIGN ONLY on approval (copy of the approving pass record)
  listing.json, listing.md          — written by LISTER; a station script adds deliverables, delivery, licence and the price fields
  qa-listing.json                   — written by QA LISTING for every review; the latest overwrites
work/<id>/qa-listing/pass1.json …   — QA LISTING's record of EVERY review (one rework allowed, so at most 2)

QA records are written by the QA agents, never by you. No timestamps: reviewers have no clock.

HANDOFF BLOCK — end every reply on the line with this block (QA adds its VERDICT line after it):
```
LISTING_ID: <id>
BRIEF: work/<id>/brief.md
DESIGN: work/<id>/set-vN/deliverables.json
STAGE_DONE: <your role>
```
The station's package gate (not an agent) refuses any package without an approved qa-design.json AND an approved qa-listing.json, and re-measures every file.
