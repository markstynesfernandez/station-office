## SKILL: ROOM 1 PACKAGE CONTRACT — QA DESIGN, DIGITAL

`<id>` = the brief's `id:` field; never invent one.
Your record of every review is qa/design-passN.json; on approval only, its copy is outbox/<id>/qa-design.json.

QA record schema (qa/design-passN.json and qa-design.json):
{
  "stage": "design",
  "listingId": "<id>",
  "pass": 1,
  "verdict": "approved" | "revise",
  "designFile": "work/<id>/set-vN/deliverables.json",
  "manifestSha256": "<copied exactly from set-vN/deliverables.sha256 (station script); missing = revise>",
  "checks": { "originality": "pass|fail", "trademarks": "pass|fail", "etsyPolicy": "pass|fail", "briefFit": "pass|fail", "complete": "pass|fail", "usable": "pass|fail", "matchesSpec": "pass|fail", "worthThePrice": "pass|fail", "licence": "pass|fail" },
  "worthThePrice": { "verdict": "pass|fail", "reason": "one or two sentences" },
  "reasons": ["one short sentence per failed or borderline check"],
  "redraw": ["revise only: each file id to redraw, e.g. 10-wooden-sled"],
  "reviewer": "QA DESIGN"
}
No timestamp field: reviewers have no clock.

HANDOFF BLOCK — end every reply with this block (your VERDICT line follows it):
```
LISTING_ID: <id>
BRIEF: work/<id>/brief.md
DESIGN: work/<id>/set-vN/deliverables.json
STAGE_DONE: QA DESIGN
```
