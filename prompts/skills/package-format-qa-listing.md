## SKILL: ROOM 1 PACKAGE CONTRACT — QA LISTING part, DIGITAL (paths are relative to the line's project folder, room1-etsy)

Listing ID (`<id>`) = the brief's `id:` field. Never invent a new ID. outbox/<id>/ holds listing.json and listing.md (LISTER, plus the station script's fields) and qa-listing.json (yours; the latest overwrites). work/<id>/qa-listing/pass1.json … is your record of every review (one rework allowed, so at most 2).

listing.json fields you check: listingId, productKey, designFile (must equal the design sign-off's), title, tags, description (AI disclosure line, digital-download notice and license text word for word), altText, deliverables [{name, format, widthPx, heightPx}], delivery, licence, priceSuggestion, listingPriceEur, variantPricesEur [{variant, priceEur}], marginEstimate, ownerTodo.

QA record schema (qa-listing.json and qa-listing/passN.json):
{ "stage": "listing", "listingId": "<id>", "pass": 1, "verdict": "approved" | "revise", "designFile": "work/<id>/set-vN/deliverables.json",
  "checks": { "originality": "pass|fail", "trademarks": "pass|fail", "etsyPolicy": "pass|fail", "briefFit": "pass|fail", "matchesFiles": "pass|fail", "limits": "pass|fail" },
  "reasons": ["one short sentence per failed or borderline check"], "reviewer": "QA LISTING" }

HANDOFF BLOCK — end every reply on the line with this block, then your VERDICT line:
```
LISTING_ID: <id>
BRIEF: work/<id>/brief.md
DESIGN: work/<id>/set-vN/deliverables.json
STAGE_DONE: QA LISTING
```
The package gate (a station script) refuses any package without an approved qa-listing.json.
