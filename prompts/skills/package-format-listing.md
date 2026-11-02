## SKILL: ROOM 1 PACKAGE CONTRACT — listing part, DIGITAL (paths are relative to the line's project folder, room1-etsy)

Listing ID (`<id>`) = the brief's `id:` field. Never invent a new ID.
Inputs: `work/<id>/brief.md`, the approved set's `work/<id>/set-vN/deliverables.json` (measured files) and `design.md` (not yours to write).
outbox/<id>/ holds: qa-design.json (QA DESIGN), listing.json and listing.md (yours), qa-listing.json (QA LISTING). QA writes its own records.

listing.json schema:
{
  "listingId": "<id>",
  "productKey": "<key from products.json>",
  "designFile": "work/<id>/set-vN/deliverables.json",   — must equal the design sign-off's designFile
  "title": "≤140 chars",
  "tags": ["≤13 tags, each ≤20 chars"],
  "description": "plain text; contains, word for word, the AI disclosure line, the digital-download notice and the product's license text (DIGITAL PRODUCT TERMS)",
  "altText": "one sentence describing the main preview image for screen readers",
  "ownerTodo": ["things only the owner can do or confirm: price, the preview images/mockups to upload, the file upload in Etsy, category and attributes"]
  (NOT yours — a station script adds them after you, from the approved set and the fee model: deliverables, delivery, licence, priceSuggestion, listingPriceEur, variantPricesEur, marginEstimate; never write them)
}

HANDOFF BLOCK — end every reply with this block:
```
LISTING_ID: <id>
BRIEF: work/<id>/brief.md
DESIGN: work/<id>/set-vN/deliverables.json
STAGE_DONE: <your role>
```
