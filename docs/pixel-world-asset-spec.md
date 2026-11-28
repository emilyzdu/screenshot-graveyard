# Pixel World: Asset Specification

For [`pixel-world-prd.md`](pixel-world-prd.md) §I. Planning only. Revised for decision
D3 (asset sourcing) and the six Portal states.

## 1. References (not production assets)

| Label | Repo path | Original Desktop file (mapped by image content; the names did not match) | Content |
|---|---|---|---|
| M-World | `docs/design/pixel-world/m-world.png` | `01-graveyard-world.png.png` | Overall world, composition, camera, HUD |
| M-Card | `docs/design/pixel-world/m-card.png` | `03-approval-portal.png` (leading space in the name) | AI Action Card beside the world; signs; selection brackets |
| M-Approve | `docs/design/pixel-world/m-approve.png` | `02-ai-action-card.png` (leading spaces in the name) | Lumi's approval stamp; a portal delivery that does not exist yet |

All three are flattened 1672×941 renders with soft, non-grid lighting. They are not
sprite sheets or tilemaps and are not drawn on a pixel grid. They must not be sliced or
used as the scene background. Two of the file names do not match their content (see the
PRD). Copy and rename the files before production; they are awaiting that move.

## 2. Art direction

- **Style:** cozy, spooky, storybook diorama pixel art. A raised frontal three-quarter
  camera; chunky silhouettes; 1 px dark-violet outlines (`#1b1433`) on characters,
  selective outlines on props.
- **Logical canvas:** 640×360. Grid: 16 px. Shown at ×2 or ×3.
- **Master palette** (32 colors maximum; extend only by review):

| Group | Colors |
|---|---|
| Night | `#120c24` `#1b1433` `#2a1f4d` `#3c3466` |
| Stone | `#4e4775` `#6e6890` `#9a93b8` `#c9c3e0` |
| Wisteria and flowers | `#6c4ab0` `#a77be0` `#d8b8ff` `#f6a6c8` |
| Light | `#f3ecff` (moon) `#ffe4a3` (candle) `#ffc764` `#f59b3c` (lantern) |
| Magic | `#b04fe0` `#e08cff` (portal), `#8fd3ff` (well water) |
| Nature | `#2f4a3e` `#4d7a5c` `#7fae7a` (moss and leaves) |
| Status | `#62d394` (approved, the same as `--sg-green`), `#f5b73d` (warning, `--sg-amber`) |

- **Lighting:** baked into each sprite. Glows are separate additive sprites (`-glow.png`)
  so their states can toggle.
- **Readability rule:** each state badge must be recognizable at ×1 (12×12) without
  color: a distinct silhouette plus color.

## 3. Asset inventory and dimensions

**Backgrounds (layered PNG, 640×360 unless noted)**

| ID | Asset | Size | Frames | MVP |
|---|---|---|---|---|
| BG-1 | Sky with stars | 640×360 | 1 (+ a 2-frame twinkle overlay, nice-to-have) | Must |
| BG-2 | Moon | 48×48 | 1 | Must |
| BG-3 | Far hill, fence silhouettes, trees | 640×160 | 1 | Must |
| BG-4 | Ground: grass, cobblestone paths (Well → Crossroads → Altar, Tower, Library, Crypt, Portal) | 640×240 | 1 | Must |
| BG-5 | Pond | 96×48 | 4 (shimmer) | Nice |

**Locations (separate sprites; footprint anchored bottom-center)**

| ID | Asset | Size | States | MVP |
|---|---|---|---|---|
| L-1 | Clock Tower with a "Calendar" sign | 112×176 | idle; active (clock-hand spin, 4 frames); error flag overlay | Must |
| L-2 | Magic Library with a "Notes" sign | 160×128 | idle; active (window page flutter, 4 frames); error flag overlay | Must |
| L-3 | Approval Altar | 112×72 | idle; candles lit 0–5 (candle overlay 8×12, 3 frames); stamp burst (6 frames, 64×64) | Must |
| L-4 | Crypt with a "Crypt" sign and a count plaque | 112×96 | idle; door glow (in and out, 4 frames) | Must |
| L-5 | Portal with a "Portal" sign | 96×128 | Six states (PRD §B-15): not connected (dim, padlock rune); connection required (dim, key rune glow, 3 frames); ready (soft swirl, 6 frames); delivering (fast swirl plus a card streak, 6 frames); delivered (a burst, 5 frames, then the soft swirl); failed or uncertain (flicker, 3 frames) | Must: not connected and connection required. Must with Phase D: ready, delivering, delivered, failed |
| L-6 | Upload Well | 64×56 | idle glow; active swirl (6 frames); a ghost rise splash (5 frames) | Must |
| L-7 | Crossroads signpost (3 arrows) | 24×40 | idle; glint (3 frames) | Must |

**Props (foreground and mid)**

| ID | Asset | Size | Frames | MVP |
|---|---|---|---|---|
| P-1 | Gravestones ×4 variants | 16×24 | 1 | Must |
| P-2 | Lanterns on posts | 16×32 | 3 (flicker) | Must |
| P-3 | Candle clusters | 16×16 | 3 | Must |
| P-4 | Iron fence segments (straight, corner, gate) | 16×24 | 1 | Must |
| P-5 | Flower clumps ×3 | 16×8 | 1 | Must |
| P-6 | Framing trees with wisteria (left, right) | 128×192 | 1 (+ a 2-frame sway, nice) | Must |
| P-7 | Sleeping cat | 24×16 | 2 (breath) | Nice |
| P-8 | Fireflies or motes | 4×4 | 4 | Nice |

**Characters**

| ID | Asset | Frame | Animations (frames @ fps) | MVP |
|---|---|---|---|---|
| C-1 | Lumi (wizard hat, scarf, lantern) | 32×40 | idle 2@4; float-right 4@8 (mirrored for left); float-up 4@8; float-down 4@8; inspect 3@10; stamp 6@10; happy 4@8; worried 2@4 | idle, 3 float directions, inspect and stamp are Must; happy and worried are Nice |
| C-2 | Lumi portrait (HUD) | 48×48 | 1 | Must |
| C-3 | Screenshot ghost body | 24×28 | idle bob 4@6; travel 4@8; sad bob 2@4; rise 4@10 | Must (idle, travel); Nice (sad, rise; reduced motion uses idle) |
| C-4 | Ghost tints ×5 | n/a | Palette-swapped sheets, **not** CSS filters (keeps the palette exact) | Must (3 tints minimum) |
| C-5 | Ghost accessories ×3 (bow, leaf, scarf) | 24×28 overlay | Follow the body frames | Nice |
| C-6 | Held card (the small screenshot card the ghost carries) | 10×8 | 1 | Must |

**Badges and HUD**

| ID | Asset | Size | Items | MVP |
|---|---|---|---|---|
| B-1 | Speech bubble | 16×16 | 1 (9-slice not needed) | Must |
| B-2 | Badge icons | 12×12 | calendar, book, image, question, padlock, check, check-outline, exclamation, sparkle (3 frames), dot; with Phase D: portal-send, receipt seal | Must (Phase D icons with Phase D) |
| B-3 | Selection brackets (orange, from M-Card) | 32×36 | 2-frame pulse | Must |
| B-4 | Lantern crowd marker with a count plate | 20×24 | 1 (the count is DOM text) | Must |
| H-1 | Toolbar icons: upload, calendar, book, crypt, settings, list view | 16×16 (shown at ×2) | 1 each | Must |
| H-2 | Panel frame (9-slice, for overlays) | 24×24 corners | 1 | Must (or CSS borders) |
| H-3 | "E" interact hint | 10×10 | 2 | Must |

## 4. Animation priority

1. **P1 (ships with the MVP):** Lumi idle, float and inspect; ghost idle and travel;
   well active; clock and library active; altar candles; stamp burst; selection
   brackets; lantern flicker.
2. **P2:** ghost sad and rise; crypt door glow; signpost glint; Lumi happy and worried.
3. **P3:** pond shimmer, cat, fireflies, tree sway, sky twinkle.
4. **With Phase D (parallel):** portal ready, delivering, delivered and failed states,
   the card streak, the receipt seal. Produce them alongside Phase D so they are ready
   when its reads land; they are never shown before a real delivery state exists.

## 5. Export rules

- PNG-8 or PNG-32, no compression artifacts, transparent background.
- Sprite sheets as horizontal strips, one row per animation, with a JSON sidecar
  `{frameWidth, frameHeight, animations: {name: {row, frames, fps}}}`.
- File names: `kebab-case`, e.g. `lumi-float-right.png`.
- Location: `frontend/src/world/assets/`, imported through Vite so the files are hashed.
- Total budget 1.5 MB or less; any single sheet 256 KB or less.

## 6. Sourcing, licensing and the asset manifest (decision D3)

**Sourcing policy.** Production assets are original AI-assisted pixel art with human
selection and refinement:
1. generate candidates;
2. a person selects them and redraws on the 16 px grid in the master palette (§2);
3. fix outlines, sizes and frame alignment by hand;
4. export to §5.

Generated images are never used unedited, and the three mockups (§1) are references
only, never sliced into sprites. Fonts are not added; sign text is baked into the art.

**Manifest.** `frontend/src/world/assets/manifest.json` is created with the first asset
and kept in review with every asset change. One entry per file:

| Field | Meaning |
|---|---|
| `id` | Inventory id from §3 (for example `L-1`) |
| `file` | Path under `frontend/src/world/assets/` |
| `origin` | `ai-assisted` (with the tool name and version), `hand-drawn`, or `third-party` |
| `refinement` | What a person changed (redraw, palette, frames), and by whom |
| `source_refs` | Mockups or other references used (for example `M-World`) |
| `license` | The project license (MIT, `LICENSE`) for original work; otherwise the exact third-party license (CC0 or CC-BY only), with attribution text |
| `intended_use` | Scene layer, sprite, HUD, or reference-only |
| `production_ready` | `true` only after the size, palette, grid and frame checks in §5 and a visual review; placeholders are `false` |
| `date` | When it was added or last changed |

The three mockups get manifest entries with `intended_use: "reference-only"` and
`production_ready: false`.

**Rules check before final release.** Confirm the Kiroween rules on AI-generated
assets, and record the result and the rule text or link in
`docs/design/pixel-world/README.md`. If AI-assisted art is not allowed, replace the
affected assets (the placeholders in §8 keep the layout working).

## 7. Production priorities

1. BG-1, BG-3, BG-4 and L-1…L-7 at idle, so the composition can be locked.
2. C-1 (idle and float) and C-3 (idle and travel) with 3 tints, plus the B-2 icons.
3. Active states for L-1, L-2, L-3 and L-6; the stamp burst; the selection brackets.
4. Props P-1…P-6 and the HUD set.
5. Everything else, as time allows.

## 8. Minimum usable asset set (MUA)

Enough for the MVP scene to be truthful and charming:
- BG-1/2/3/4;
- L-1…L-7 (idle, plus active for the well, tower and library; the altar with candles
  and the stamp; the portal's not-connected and connection-required states);
- P-1/2/4/6;
- C-1 (idle, float-right mirrored, float-up, float-down, inspect, stamp) and C-2;
- C-3 (idle, travel) × 3 tints, and C-6;
- B-1…B-4, H-1, H-3.

Everything else is optional polish. If an asset is late, a placeholder (a flat
silhouette in palette colors at the final size) keeps the layout and tests stable.
