# ASSETS.md — Station (office-agents)

Every 3D asset, font, dependency, tool and data source used by Station (office-agents), with its source and licence. Nothing in
this project comes from ajsahni/agents-office, sahni.ai or any non-permissive repository. Nothing was fetched from
starnetos.com. The StarNet name, logo, artwork and sprites are not licensed and are not used anywhere here.

## 3D assets

Up to Redesign R2, all geometry is generated procedurally in Three.js at runtime and every texture is drawn with the 2D canvas API at
start-up (`src/web/scene/`). No model files, image textures or sprite sheets are bundled, so there is no third-party
asset licence file to ship. Kenney's CC0 kits remain an allowed option; Redesign R1 did not use them (procedural gave
the control over instancing and merging that the frame budget needed, and no download or archive was involved). If a
kit is added later, it is recorded here with its version, source URL and licence file in the repo.

**Mood references (not assets).** `design-refs/01-main.png` to `05.png` are other people's renders, kept locally as mood
references only and ignored by git. Nothing was traced or copied from them: no layout, model, artwork or texture.

**Redesign R1 (16/10/2026).** All entries below are procedural and made for this project; licence: this project.

| Asset | Made with | Where |
|-------|-----------|-------|
| Floor plan: three cutaway department rooms, lounge, server closet, atrium | own layout (`computeLayout`) | `scene/layout.js` |
| Floor slab, back walls with caps, baseboards and cut ends, low closet partition | `BoxGeometry`, merged per room into one vertex-coloured mesh | `scene/rooms.js` |
| Wood plank floors, atrium stone tiles (stone replaced by polished concrete in R2) | `CanvasTexture`s drawn from a seeded generator, planar UVs | `scene/textures.js` |
| Library wall (bookcase, books, binders with blank label patches, flat stacks) | boxes; sizes and colours from a seeded generator; no text or titles | `scene/rooms.js` |
| Mood board, whiteboard, framed pictures | one canvas atlas: seeded abstract compositions (circles, bands, blocks, arcs), colour swatches, wavy lines in place of writing; no text; not copies of any artwork | `scene/textures.js` |
| Reading nook (armchair, arc lamp, side table), credenza, lockers, wall shelves with objects | boxes, `RoundedBoxGeometry`, cylinders, cones | `scene/rooms.js` |
| Lounge: two sofas, two armchairs, coffee table, rug, arc lamp | `RoundedBoxGeometry`, boxes, cylinders | `scene/rooms.js` |
| LED strips (emissive lines) and their soft glow (additive quads), lamp light pools | boxes; a canvas glow atlas (radial pool, vertical wash) | `scene/rooms.js`, `scene/textures.js` |
| Desks (wood top, dark metal frame, L-shaped return), monitors, keyboards, desk lamps, office chairs | `RoundedBoxGeometry` (one bevel segment), cylinders, cones; instanced (`InstancedMesh`) | `scene/office.js` |
| People (body, head, arms, legs; replaced by the R2 figures below), soft blob shadows | `CapsuleGeometry`, `SphereGeometry`, `RoundedBoxGeometry`, a radial canvas texture; instanced | `scene/office.js` |
| Plants (tall and small) | cylinders + merged `IcosahedronGeometry` leaves; instanced | `scene/office.js` |
| Server cabinets with status lights and LED blocks | `RoundedBoxGeometry`, planes, spheres; instanced | `scene/office.js`, `scene/rooms.js` |
| Memory core | `OctahedronGeometry` crystal, `TorusGeometry` ring, radial-gradient glow sprite, octagonal plinth | `scene/office.js`, `scene/rooms.js` |
| Monitor screens | status-colour glow at overview; `CanvasTexture` text when zoomed in or selected | `scene/monitor.js` |
| Slab drop shadow | a blurred rounded rectangle on a canvas | `scene/office.js` |
| Backdrop | a CSS linear gradient behind the transparent canvas (colours from the palette) | `scene/office.js` |
| Activity lines | `QuadraticBezierCurve3` + `LineDashedMaterial` | `scene/office.js` |

**Redesign R2 (17/10/2026).** Still no kit, model file, image file or font: everything below is procedural and made
for this project; licence: this project. `design-refs/02.png` was used for mood only (light-mode contrast).

| Asset | Made with | Where |
|-------|-----------|-------|
| People: head with neck, nose and ears; hair in four styles (short crop, bob, bun, curls); torso; upper arms and forearms; hands; thighs and shins; shoes; per-agent shirt (the agent's colour), skin tone, hair colour and trousers | `SphereGeometry` (head, partial spheres for hair), `IcosahedronGeometry` (curls), `RoundedBoxGeometry` (torso, pelvis), six-sided `CylinderGeometry` limbs, `BoxGeometry` hands and shoes; one instanced mesh per part; poses from joint angles | `scene/office.js` |
| Props: printer, water cooler, five benches, a round meeting table with two stools, an easel with a picture, two wall clocks (no time or text), a wall shelf above the printer | boxes, `RoundedBoxGeometry`, cylinders; merged into the atrium mesh | `scene/rooms.js`, positions in `scene/layout.js` |
| Trailing shelf plants (the third plant type, beside the tall leafy plant and the small pot plant) | `IcosahedronGeometry` leaves hanging from a small pot | `scene/rooms.js` |
| Atrium floor: polished concrete (replaces the R1 stone tiles) | `CanvasTexture`: soft clouding, fine specks, thin saw-cut joints, from a seeded generator | `scene/textures.js` |
| Top-bar service glyphs: a spark, a route, an upscale arrow, a shop bag, a dashed ring | inline SVG paths written for this project (generic shapes, not any company's logo) | `src/web/main.js` |

**R3 spike: baked Design room (17/10/2026), behind `?scene=baked` only; replaced by R3a below.** The first non-procedural assets. The room is
modelled in code by `scripts/blender/build-design-room.py` (no model file, kit or download is used for geometry), lit and
baked in Blender, and exported to glTF. Blender's outputs are this project's own (licence: this project); the five
photo textures inside them are CC0 (below). `design-refs/05.png` was used for mood only (dark walls, warm wood): no
layout, model, artwork or texture was traced or copied.

| Asset | Made with | Where |
|-------|-----------|-------|
| Design room shell (floor, two walls, caps, skirting), wood slat wall panel, three oak shelves with binders (blank label patches, no text) and vases, ten fabric wall pads, a rug, two walnut desks with drawer pedestals (the first L-shaped), two ergonomic chairs, two desk lamps, a fiddle-leaf fig, a small pot plant, an easel with an abstract picture (coloured blocks), LED strips under the shelves and along the floor edge of both walls | Python in Blender 5.2.1 (boxes, cylinders, low-poly spheres, polygon leaves), seeded; sizes and positions from `layout.js` `bakedRoomSpec` | `src/web/assets/design-room/design-room.glb` (710 KB; 4,676 triangles; JPEG textures at 512 px) |
| Day and evening lightmaps | Cycles bake (diffuse, direct + indirect, no colour), OptiX on the GPU, 2048 px, 1024 samples, scaled and stored 8-bit sRGB | `src/web/assets/design-room/lightmap-day.webp`, `lightmap-evening.webp` (WebP via sharp, quality 90) |
| Manifest (spec, lightmap scales, LED strips, build info) and sizes | `scripts/build-design-room.mjs` | `src/web/assets/design-room/manifest.json`, `sizes.json` |

The spike's files (`build-design-room.*`, `src/web/assets/design-room/`) were removed in R3a.

**R3a: baked Design and Office rooms (17/10/2026), the default scene (`?scene=procedural` turns them off).** Built in
code from the shared library `scripts/blender/office_lib.py` (room recipes in `office_rooms.py`, driver `build-office.py`,
run by `npm run build-office`), lit and baked in Blender, exported to glTF. Blender's outputs are this project's own
(licence: this project); the five photo textures in them are CC0 (below). No model file, kit or download is used for
geometry. The pictures, the mood board and the whiteboard show the page's own procedural atlas (`textures.js`), so no
new artwork file exists. `design-refs/` was not used in R3a.

| Asset | Made with | Where |
|-------|-----------|-------|
| Shared library: desk (walnut or oak top, drawer pedestals, optional L return), task chair, desk lamp, rug, binder shelf (binders with blank label patches, no text), wall shelf with books, box and trailing plant, two-door locker, credenza, round meeting table with two stools, easel, oak slat panel, mood board (oak frame), whiteboard with marker tray, framed picture, LED strips; plants: fiddle-leaf fig, small pot plant, trailing shelf plant | Python in Blender 5.2.1 (boxes, cylinders, low-poly spheres, polygon leaves), seeded | `scripts/blender/office_lib.py` |
| Design room (9.7 x 5.2) and Office room (10.9 x 8.7): shells (floor, walls, caps, skirting, cove LEDs) and the library pieces placed from `layout.js` `bakedRoomSpec` | as above; 9,948 triangles (Design 4,032, Office 5,916) | `src/web/assets/office/office.gltf`, `office.bin` |
| Shared textures, each written once: oak, walnut, floor (mid-tone oak), fabric, rug | the CC0 photos below, resized to 512 px and colour-shifted in Blender, JPEG quality 82 | `src/web/assets/office/textures/*.jpg` (238 KB together) |
| Day and evening lightmap atlases (every baked room in one atlas per mode) | Cycles bake (diffuse, direct + indirect, no colour), OptiX on the GPU, 3072 px, 1024 samples, scaled and stored 8-bit sRGB | `src/web/assets/office/lightmap-day.webp`, `lightmap-evening.webp` (WebP via sharp, quality 90) |
| Manifest (per-room spec, look, lightmap scales, LED strips, build info) and sizes | `scripts/build-office.mjs` | `src/web/assets/office/manifest.json`, `sizes.json` |
| Oak floor of the procedural rooms and the lounge | the shared `textures/floor.jpg`, same scale (`bakedlook.js` `FLOOR_OAK`) | loaded by `scene/baked.js`, used in `scene/office.js` |

Size: 2,762,638 bytes as served for everything in `src/web/assets/office/` (27.6% of the 10 MB office budget).

**R3b: every area baked (17/10/2026).** The Research room, the lounge and the atrium join the Design and Office rooms,
from the same library and the same five photo textures; still no model file, kit or download for geometry, and no new
texture file: the atrium's concrete shows the page's own canvas concrete (`textures.js` `tileTexture`), as the decals
show its atlas. The R3a files `office.gltf`, `office.bin`, `lightmap-day.webp` and `lightmap-evening.webp` were replaced
by one set per bake unit.

| Asset | Made with | Where |
|-------|-----------|-------|
| Library additions: chamfered upholstery boxes, a library bookcase (procedural spines in plain colours, no titles; binders with blank labels), three-seat sofa, leather armchair, coffee table, side table, arc floor lamp, bench, printer, water cooler, wall clock (no particular time), the slab, the core plinth, the closet's floor, partition and cable tray | Python in Blender 5.2.1, seeded | `scripts/blender/office_lib.py`, recipes in `office_rooms.py` |
| Four bake units: Research (8,438 triangles), Design (4,032), Office (5,916), atrium with lounge (3,004 + 3,096) | as above, placed from `layout.js` `bakedRoomSpec` | `src/web/assets/office/<unit>.gltf`, `<unit>.bin` |
| Day and evening lightmap atlases, one pair per unit | Cycles bake as R3a, OptiX, 1024 samples, 100 texels per unit (Research 2432 px, Design 1984, Office 2176, atrium 3008) | `src/web/assets/office/lightmap-<unit>-day.webp`, `-evening.webp` |
| Shared textures, each one file: oak, walnut, floor, fabric (now a light neutral, tinted per material), rug (likewise, tinted dark grey) | as R3a | `src/web/assets/office/textures/*.jpg` (272 KB together) |

Size: 6,877,262 bytes as served (68.8% of the 10 MB office budget; gzip 4,880,432, brotli 4,674,851); per file in
`screenshots/r3b/asset-sizes.json`. Per unit: Research 2,264,407, Design 1,044,486, Office 1,470,579, atrium with lounge
1,789,062; shared textures 279,522; manifest 29,206.

**R4a: the warm Office prototype and quality tiers (17/10/2026).** The Office bake unit only; the other four areas are
unchanged (their files are byte-identical to R3b). Owner's style direction: `design-refs/02.png` (warm cream walls, beige
large-format tile, a dark rug per desk zone, warm pendants, light wood, plants, a dark plinth), with the light wood floor
band and plinth deck, desk and wall lamps and wall-mounted shelves from `design-refs/01-main.png`. Both are mood
references only, kept local and ignored by git (`git ls-files` lists neither): nothing was traced, sampled, measured or
extracted from them, and no layout was copied (the room's plan is still `layout.js`). Every asset below is made in this
repository; licence: this project. No new texture was downloaded; no new dependency.

| Asset | Made with | Where |
|-------|-----------|-------|
| Warm palette and tone mapping (one file): cream walls and caps, beige tile and grout, light wood, charcoal rug, cream pedestals, warm-charcoal metal, terracotta / sage / soft brown accents, pot and book colours, window panes per theme, AgX exposure | own choice | `src/web/config/warm-office.js` |
| Floor tile texture: beige large-format tile (0.9 m), grout lines, a tone per tile, soft clouding and speckle (seeded FFT noise; tileable) | numpy in Blender, `gen_tile` | `src/web/assets/office/textures/tile.jpg` (1024 px) |
| Wall plaster texture: low-contrast clouding and grain, tinted per theme (seeded) | numpy in Blender, `gen_plaster` | `textures/plaster.jpg` (512 px) |
| Light wood: the CC0 oak veneer photo below, shifted to a light wood (`#cfb08a`) | as the other shared textures | `textures/lightwood.jpg` |
| Warm Office pieces: thick plaster walls with bevelled caps and capped cut ends; a window wall (three openings, light wood frames, sills, mullions, transoms; unlit panes); light wood skirting; tiled floor in a light wood edge band; the plinth deck (light wood fascia over a dark base); a light wood bookcase (plain-colour spines, blank binder labels, no titles); two wall shelves; two framed abstract pictures (the page's own atlas); two wall lamps; one charcoal rug; bevelled light wood desks with cream pedestals; desk lamps; dome pendants; mugs (plain, no logo), notebooks, pen cups, small succulents; the meeting table with terracotta stools; a snake plant and pot plants in warm pots | Python in Blender 5.2.1 (`office_lib.py` R4a section, `office_rooms.py` `office()`), seeded; furniture edges chamfered (`Kit.fbox`, 12 mm) | `src/web/assets/office/office.gltf`, `office.bin` |
| Lightmaps, two tiers: default 3072 px atlas (R3b: 2176), high 6144 px (`high/`, loaded only in the high tier); one Cycles bake at 6144 px, the default halved in linear light | Cycles bake (OptiX), 512 samples, sharp | `lightmap-office-day.webp`, `-evening.webp`; `high/lightmap-office-*.webp` |
| Status-light ring (readability): a dark disc under each desk's status light | `CylinderGeometry`, instanced | `src/web/scene/office.js` |

Compressed textures: the pipeline stays JPEG (albedo) and WebP (lightmaps). KTX2/Basis would need a new encoder tool and
the Basis transcoder; it was not added (it saves GPU memory, not download size, at these sizes).

**Third-party textures (CC0 1.0, Poly Haven).** Five 1k diffuse JPGs, downloaded 17/10/2026 from the Poly Haven API
and checked against its MD5: `assets-src/polyhaven/` (source URLs, publication dates, authors and MD5s in
`assets-src/polyhaven/SOURCES.md`). Licence text: `assets-src/licences/CC0-1.0.txt` (CC0 1.0 Universal legal code, from
https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt; sha256 a2010f34…0499). Poly Haven licence page:
https://polyhaven.com/license.

| File | Source | Published | Licence | Used for |
|------|--------|-----------|---------|----------|
| `oak_veneer_01_diff_1k.jpg` | https://polyhaven.com/a/oak_veneer_01 | 2024-03-08 | CC0 1.0 | slats, shelves, mood board frame, easel, meeting table, Office and Research desk tops, the Design desk tops by day (R3b), the bookcase, benches, tables; R4a: shifted to the light wood (`textures/lightwood.jpg`) of the warm Office |
| `walnut_veneer_diff_1k.jpg` | https://polyhaven.com/a/walnut_veneer | 2026-08-11 | CC0 1.0 | drawer fronts; the Design desk tops and credenza top by evening |
| `wood_floor_diff_1k.jpg` | https://polyhaven.com/a/wood_floor | 2023-10-24 | CC0 1.0 | the office floor everywhere, baked and procedural (R3a: shifted to a mid-tone oak, `#a47f58`) |
| `poly_wool_herringbone_diff_1k.jpg` | https://polyhaven.com/a/poly_wool_herringbone | 2025-09-05 | CC0 1.0 | upholstery: task chairs (charcoal), lounge sofas (R3b: beige by day, grey by evening); one file, tinted per material |
| `hessian_230_diff_1k.jpg` | https://polyhaven.com/a/hessian_230 | 2025-09-05 | CC0 1.0 | rugs (R3b: dark grey in every area, tinted per theme; R3a's were oatmeal) |

Palette: `src/web/config/palette.js` (own choice; one accent per department used as a soft wall tint and on the cards;
light and dark themes; one warm accent in dark mode, shared with the UI's `--accent` in `src/web/styles.css`).

## Fonts

No font files are bundled. The page uses the system font stack (`Segoe UI`, `system-ui`, `Helvetica Neue`, Arial)
and the system monospace stack (`Cascadia Code`, `Consolas`, `ui-monospace`). Nothing is downloaded at runtime.

## Data in `fixtures/`

| Item | Source | Notes |
|------|--------|-------|
| `fixtures/station-root/` | read-only snapshot of the owner's own StarNet build (`Virtual-workers`), taken by `npm run snapshot-fixtures` | owner's data, internal only. Prompts removed (roster `system`, runs `deliveryPrompt`), save trimmed to rooms/props/agent basics, images copied only as PNG thumbnails (max 384 px). Secrets (`.secrets/`, `.env`, provider keys) are refused by name and never read. Details and the skip list: `fixtures/SNAPSHOT.json`. Contains prices, margins and costs, so keep it internal. |
| `fixtures/synthetic/overlay.json` | hand-written for this project | test states the real snapshot lacks (working, error, waiting, blocked). Applied in fixtures mode only; shown with a "synthetic" tag. |

## Dependencies (pinned, licence-checked)

| Package | Version | Licence | Use | Where |
|---------|---------|---------|-----|-------|
| three | 0.186.1 | MIT | renderer, geometry, post-processing (`EffectComposer`, `RenderPass`, `GTAOPass`, `OutputPass`, `Pass`/`FullScreenQuad`, `CopyShader`, `RoundedBoxGeometry`, `BufferGeometryUtils`); R3 spike: `GLTFLoader` (loads the baked Design room) | `dependencies`; served to the browser from `node_modules/three/build` and `examples/jsm` only |
| sharp | 0.34.5 | Apache-2.0 | downscales design and print PNGs into thumbnails: `scripts/snapshot-fixtures.mjs` now; the server's `.cache/thumbs/` in Phase 2 (decision 9); since the port batch (17/10/2026) also the engine's digital build (clean-up, padding, PNG optimisation with the libimagequant 2.4.1 built into its prebuilt libvips, BSD-2-Clause per the package's own README, lovell/libimagequant fork), the deterministic prop edits and the listing photos. Same version the owner's station already uses. | `dependencies` |
| @img/sharp-win32-x64 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later | sharp's prebuilt binary; bundles libvips 8.17.3 (LGPL-3.0-or-later, dynamically linked, unmodified) | transitive (optional, platform-specific) |
| @img/colour | 1.1.0 | MIT | sharp dependency | transitive |
| detect-libc | 2.1.2 | Apache-2.0 | sharp dependency | transitive |
| semver | 7.8.5 | ISC | sharp dependency | transitive |
| croner | 10.0.1 | MIT | cron parsing and next-run times for routines (`src/engine/scheduler.mjs`), Europe/Dublin; no dependencies of its own | `dependencies` |
| @anthropic-ai/sdk | 0.131.0 (exact pin; published 2026-09-30T23:03:22Z on npm, 17 days before it was added; the newest release at least 14 days old on 17/10/2026; integrity sha512-9+PepoU7…Mbepw==) | MIT | the official Anthropic SDK: the live text provider's client (E6 step a0, owner-approved 17/10/2026), `src/engine/providers/anthropic.mjs` only, with the SDK's retries and logging off and the base URL fixed. Its optional peer `zod` is not installed. | `dependencies` |
| json-schema-to-ts | 3.1.1 | MIT | @anthropic-ai/sdk dependency (types for tool schemas) | transitive |
| @babel/runtime | 7.29.10 | MIT | json-schema-to-ts dependency | transitive |
| ts-algebra | 2.0.0 | MIT | json-schema-to-ts dependency | transitive |
| standardwebhooks | 1.1.1 | MIT | @anthropic-ai/sdk dependency (webhook signatures; not used by the station) | transitive |
| @stablelib/base64 | 1.0.1 | MIT | standardwebhooks dependency | transitive |
| playwright | 1.64.1 | Apache-2.0 | Chromium / Chrome automation for `npm run screenshots` (captures station-office's own page only) | `devDependencies` |
| playwright-core | 1.64.1 | Apache-2.0 | transitive dependency of playwright | `devDependencies` (transitive) |
| Chromium (downloaded by `npx playwright install chromium`, build 1248) | per Playwright | BSD-3-Clause (Chromium) | headless screenshot browser; not redistributed with this project | `~/AppData/Local/ms-playwright` |
| Google Chrome (already installed on this PC) | system | Google Chrome Terms of Service | only for `node scripts/screenshots.mjs --headed` (fps as seen in headed Chrome) and `npm run demo:record` (headed recording); not redistributed | system install |
| ffmpeg, Playwright build 1013 (downloaded with Playwright's browsers) | pinned by playwright-core 1.64.1 (`browsers.json`) | LGPL-2.1 (`COPYING.LGPLv2.1` in its folder) | Playwright's own video capture for `npm run demo:record` (WebM, VP8/VP9). `demo-record.mjs` also runs it to read the WebM's duration and probes it for MP4 output: it has no MP4 muxer or H.264/MPEG-4 encoder, so no .mp4 is made. A system ffmpeg on PATH (GPL-3.0 "full" build on this PC) is never used: it is not pinned or licence-checked here. | `~/AppData/Local/ms-playwright/ffmpeg-1013` |

## Tools (not shipped)

| Tool | Version (pinned) | Licence | Use | Where |
|------|------------------|---------|-----|-------|
| Blender | **5.2.1 LTS** (build 9e2066aef7ef, 2026-08-25; series 5.2 LTS, supported to July 2028). The owner installed it from https://www.blender.org/download/lts/5-2/. `scripts/build-office.mjs` (R3a; the spike's `build-design-room.mjs` before it) refuses any version outside 5.2.x unless `--any-blender` is given. | GPL-2.0-or-later (the program). Files made with it are not covered by the GPL: the glTF, its buffer, the textures as exported, the lightmaps and the manifest are this project's own (Blender licence FAQ). | headless modelling, Cycles bake and glTF export (R3 spike; since R3a `npm run build-office`); bundled add-on: glTF 2.0 I/O 5.2.40 (Apache-2.0) | `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe` (or `BLENDER_EXE`) |
| Real-ESRGAN ncnn Vulkan (`realesrgan-ncnn-vulkan.exe`) | **v0.2.5.0, build 20220424** (Windows), sha256 `07e49f7cbb4ede01ae4dd4c399d3a7e5846e3d2085c3128eff881e55cb7b1a0c` | **MIT** (Real-ESRGAN-ncnn-vulkan: Copyright (c) 2021 Xintao Wang; includes realsr-ncnn-vulkan, Copyright (c) 2019 nihui), statically built on ncnn (BSD-3-Clause, Tencent) | the digital build's upscale (port batch 17/10/2026, owner decision: a local child process, pinned path and sha256, no network, inside the job jail, killed by the E-STOP; `src/engine/lib/esrgan.mjs` only). $0 per image, local GPU | `tools/realesrgan/` (git-ignored, never committed), pinned in `config/engine.json` `upscale` |
| `vcomp140.dll` (shipped beside the binary in the same release zip) | sha256 `8f72ef2e483465444b2059fc6744d6cb22cd8d8a27f6fa56befd2a42dcd0f78b` | Microsoft Visual C++ OpenMP runtime, redistributable with the application (Visual Studio redistributable terms) | needed by the binary | `tools/realesrgan/` (git-ignored) |
| Model `realesrgan-x4plus` (`.param` + `.bin`) | sha256 `35330ece…0a86` (param), `713ee713…cddf` (bin); full hashes in `config/engine.json` | **BSD-3-Clause** (Real-ESRGAN: Copyright (c) 2021, Xintao Wang) | the 4x model the build runs (the build key names it) | `tools/realesrgan/models/` (git-ignored) |

The Real-ESRGAN files were copied, read only, from the legacy station's download (`Virtual-workers/station/tools/realesrgan/`,
downloaded there 2026-10-15 from https://github.com/xinntao/Real-ESRGAN/releases, `realesrgan-ncnn-vulkan-20220424-windows.zip`);
each copy is sha256-identical to the legacy file. Only the files the build needs were copied (the anime models were not). The
licences were checked on 17/10/2026 against https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE (BSD 3-Clause) and
https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/LICENSE (MIT). The release zip's own licence files were not in
the legacy folder; the owner may want to keep a copy of the zip with them. Nothing of Real-ESRGAN is committed or shipped in
the repo; its outputs (the buyer's PNGs) are the owner's.

npm reports an install script for sharp that is not run (`allowScripts`); it is not needed because the prebuilt
binary package is used.

Node.js built-ins only otherwise (`http`, `fs`, `path`, `os`, `url`, `crypto`, `node:test`, and `node:sqlite` for the engine store, which uses the SQLite build bundled with Node, 3.53.0 on Node 24.16, public domain). No bundler, no transpiler. `better-sqlite3` was tested against and not installed (DECISIONS.md, E2 store). The Anthropic SDK is installed since E6 step a0 (above); no other HTTP client is used.

## Code copied from the owner's own station code

`src/lib/legacy-readers/*.mjs` (the legacy view's readers) and `src/engine/lib/*.mjs` (the engine's business rules),
plus `config/station.config.json`, `config/products.json`, `config/blocklist.txt`, `prompts/` and `tests/ported/`, come from
`Virtual-workers/station/`, the owner's own code with no third-party code. `PORTED.md` lists each one with its source sha256
and changes, and each code file names its source in a header comment. Nothing from `starnet/`
(androoAGI/starnet, MIT code, unlicensed artwork) is imported or copied.

## How to re-check

```
npm ls --all --omit=optional
node -e "for (const p of ['three','sharp','croner','@anthropic-ai/sdk','json-schema-to-ts','@babel/runtime','ts-algebra','standardwebhooks','@stablelib/base64','@img/sharp-win32-x64','@img/colour','detect-libc','semver','playwright','playwright-core']) console.log(p, require('./node_modules/'+p+'/package.json').version, require('./node_modules/'+p+'/package.json').license)"
```
