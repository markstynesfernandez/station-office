## SKILL: GENRE BRIEF FORMAT (genre-scout line; research briefs use it too; a station script checks it when the draft is written)

One brief = one Markdown file: `scout-drafts/<today>/<id>.md` (genre scout, `origin: genre-scout`) or `drafts/<today>/<id>.md` (research line, `origin: research`, no `## Genre trend evidence`). `id` = `YYYY-MM-DD--short-slug` (lowercase a–z, 0–9 and hyphens, at most 60 characters, the date = today); the file name is `<id>.md`. A draft that breaks this format is NOT written: the write returns the problems, fix every one and write it again.

EVIDENCE (owner, 19/10/2026): NO ETSY DATA until Etsy authorises it in writing. etsy.com is blocked for search and fetch, and no etsy.com URL may appear anywhere in a brief. Demand evidence comes from WEB SEARCH RESULTS of non-Etsy sources: trend articles, editorial roundups, community discussion and other marketplaces, recorded exactly as the results show them. Never type, build or guess a URL: cite and fetch only URLs your searches returned. The evidence level is `indicative` and the competitor count `not measured`. Where PRICE RULES speak of the top-5 prices, read: the prices of the results in your Demand evidence table. No placeholder anywhere (UNKNOWN, TBD, N/A, "needs owner check"): with no evidence, write no brief and call `report_blocked` with the reason. Lines `own shop: ... (recorded by owner, YYYY-MM-DD)` are the owner's own shop results: only the owner writes them.

```
---
id: 2026-10-17--cozy-farming-desk-props
date: 2026-10-17
status: candidate
product_type: <a key from products.json>
audience_segment: <who buys it, plain words>
origin: genre-scout
---
# Niche
One line.

## Buyer persona
Who buys it, for what use. No real people.

## Demand evidence
evidence level: indicative
checked: YYYY-MM-DD
search queries: <the exact web_search queries the rows come from, separated by ;>
competitor count: not measured
| # | result title (as shown in the result) | price (as shown) | result URL |
|---|---|---|---|
| 1 | <title as the result shows it> | USD 4.99 | <the URL the result gave> |
(at least 3 rows, non-Etsy results only; price = the raw string exactly as the result showed it: `USD 4.99`; a sale `USD 7.49 (was 9.99)`; a range `USD 4.50–18.75`; or `no price` only when the result shows none (an article or a discussion). A price the result shows goes in the price cell, never only in the title. Every number must be one the results showed: the station checks it against the job transcript)
product fit: same product — <research briefs: how the results sell or discuss the products.json product itself>

## Genre trend evidence
- <URL a search returned> — what it shows about the genre as a whole (genre-scout briefs only)

## Keywords
- <phrase> — <URL of a result that shows the phrase in use>
(5–13 phrases; at least 3 different result URLs across them)

## Price range
USD <low>–<high> — <result URL>, <result URL>, <result URL>
(at least 3 different results that show those prices; the FULL range as shown: low = the lowest current price of the rows (a range at its low end), high = the highest, never a "was" price. If NO row shows a price, write `owner sets price — no cited result shows a price` instead, with no figure: the owner sets the price at approval)

FLOOR (owner; the BRIEF PRICE RULES floor): the floor is our minimum listing price, not a limit on the market. A brief with prices passes when at least 3 rows show a current price at or above the BRIEF FLOOR. Record every result your named searches showed below the floor as a row too: never drop or hide a cheap row (the station checks the transcript). `owner sets price` is only for a brief whose rows show no price at all.

## Seasonality
`not measured (no source)`, or when demand peaks (or "evergreen") with the URL of a result that supports it. Never claim a season no cited result shows.

## Design direction
What the files are and two or three ORIGINAL concept ideas in plain words. Never describe another seller's design.

## Risks
IP and Etsy-policy risks and how the concept avoids them.

## Sources
- <every URL cited above> — what it supports
```

Every URL anywhere in the brief must also be listed under `## Sources`, and must be one a web call of this job returned (the station checks the job transcript).
EVIDENCE-CHECKER adds `## Evidence check` and sets `status: verified` or `status: rejected` in the same file; a station script, never an agent, writes any `## Station ...` section.
