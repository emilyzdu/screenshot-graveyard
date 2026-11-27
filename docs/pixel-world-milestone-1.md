# Pixel World Milestone 1: playable shell with real ghosts

The smallest safe first slice of [`pixel-world-prd.md`](pixel-world-prd.md) (Phases 1–2,
plus read-only real data). Planning only; not implemented.

## Scope

**In:**
- `?view=world`, loaded on demand; the default route is unchanged.
- An original layered environment. Placeholder silhouettes are allowed where final art
  is not ready yet, and are flagged in the asset manifest.
- Lumi with keyboard and pointer movement, idle, facing, inspect and collision
  rectangles.
- A ghost per **real** active screenshot from `GET /api/screenshots` (read-only).
  M1 shows only list-derived states: *not analyzed yet* (at the Upload Well) and
  *analyzed* (at the Lantern Crossroads). Archived screenshots appear only as the Crypt
  count.
- Building hotspots that open overlays directly, without walking.
- Overlays:
  - **Action Card** hosting the existing `RevivePanel`, `CalendarDraft` and
    `MakeNotesDraft` unchanged, with the same props as `LiveAssistant` and the drawer;
  - **Quick Queue** (an accessible list of ghosts);
  - **Crypt** (a read-only archived list, plus "Resurrect in List view");
  - **Portal** ("Not connected");
  - **Settings** (the provider badge and a "List view" link).
- Fallback: a "List view" link, plus an error boundary that falls back to it.

**Out (Milestone 2 and later):**
- the `useWorldStatus` scheduler and the full PRD §F mapping (preparing, ready for
  review, approved, failed);
- `AutoPilot` in the card;
- Bury and Resurrect inside the world (this needs the `useLifecycle` refactor);
- upload through the well (the M1 well opens a "Upload in List view" hint);
- the approval stamp animation;
- the Portal's delivery states;
- the D1 measurement.

M1 changes no existing files except `App.tsx` and the ESLint config, and makes no
backend changes.

## Files to create

| Path | Responsibility |
|---|---|
| `frontend/src/App.tsx` (edit) | Add `view === 'world'` → `lazy(() => import('./world/PixelWorld'))` inside `Suspense`; default unchanged |
| `frontend/eslint.config.js` (edit) | `no-restricted-imports` forbidding `**/api/*` in `src/world/{scene,lumi,model,hud}/**` |
| `src/world/PixelWorld.tsx` | Root: workspace start, preload assets, error boundary, layout (scene, HUD, overlay host) |
| `src/world/WorldErrorBoundary.tsx` | Renders "The world could not load" plus a List view link |
| `src/world/data/useWorldGallery.ts` | `getWorkspace()` then `listScreenshots()` with a bounded fetch and ticketed latest-wins; refresh on visibility return. Read-only |
| `src/world/model/ghostView.ts` | Pure: `deriveGhostViewM1(screenshot) → GhostView` (PRD §E, technical design §5); `hash(id)` tint and accessory |
| `src/world/model/slots.ts` | Pure: deterministic slot positions per location, from the rank of the id |
| `src/world/model/locations.ts` | Static table: id, label, anchor, footprint (collision) rect, hotspot rect, overlay id |
| `src/world/lumi/lumiController.ts` | Pure `step(state, input, dtMs, colliders) → state` (speed 72 px/s, diagonal normalization, clamping, facing) |
| `src/world/lumi/useLumiInput.ts` | Key and pointer listeners on the scene element only; ignores events from inputs and dialogs |
| `src/world/scene/SceneViewport.tsx` | 640×360 stage, integer scale, `role="application"`, focus, one rAF loop (pauses when hidden), y-sorting |
| `src/world/scene/Layers.tsx` | Background and foreground image layers |
| `src/world/scene/LocationHotspot.tsx` | A `<button>` per location (label, hover, active state); emits `open(locationId)` |
| `src/world/scene/GhostSprite.tsx` | A `<button>` per ghost (label: filename and state); idle bob; wandering inside its slot radius; emits `select(id)` |
| `src/world/scene/LumiSprite.tsx` | Sprite frames by facing and state; reduced-motion aware |
| `src/world/hud/Toolbar.tsx`, `src/world/hud/LumiPortrait.tsx` | Direct controls (Quick Queue, Calendar, Notes, Crypt, Settings, List view) |
| `src/world/overlays/OverlayHost.tsx` | One overlay at a time; Escape closes it; focus returns to the opener |
| `src/world/overlays/ActionCard.tsx` | Header (id, filename, preview via `imageUrl`), then the existing `RevivePanel`, `MakeNotesDraft` and `CalendarDraft` |
| `src/world/overlays/QuickQueue.tsx`, `CryptOverlay.tsx`, `PortalInfo.tsx`, `SettingsOverlay.tsx` | As in Scope |
| `src/world/world.css` | Stage scaling, `image-rendering: pixelated`, overlay frame |
| `src/world/assets/manifest.json` | Asset manifest (asset spec §6), with an entry for every file, including placeholders and the three reference mockups |
| `src/world/assets/*.png` | The M1 subset of the asset spec §8 (placeholders allowed, marked `production_ready: false`) |

## Acceptance tests (exact)

The tests use Vitest and Testing Library, with `api/ai` and `api/client` mocked the
same way as `src/shell/LiveAuto.test.tsx`.

**`src/world/model/ghostView.test.ts`**
1. Each active screenshot maps to exactly one view with `id === screenshotId`; archived
   screenshots map to none.
2. `analysis: null` gives `location 'well'` and the label "Not analyzed yet"; an
   analysis gives `'crossroads'` and "Analyzed", with the category badge from PRD §E.
3. Tint and accessory are stable for the same id across calls; ids 1 to 500 produce all
   5 tints.
4. A duplicate screenshot gets its own view with `isDuplicate` marked.

**`src/world/model/slots.test.ts`**
5. Slots are deterministic for the same set of ids, never overlap inside one location,
   and the 25th ghost and beyond become one crowd marker with the correct count.

**`src/world/lumi/lumiController.test.ts`**
6. Holding Right for 1000 ms moves Lumi 72 ± 1 px; Right+Down moves √2-normalized
   (72 ± 1 px total).
7. Lumi never enters a collider rectangle; it slides along the edge.
8. Facing follows the last horizontal or vertical intent; idle starts after 2000 ms
   without input.

**`src/world/PixelWorld.test.tsx`**
9. `/?view=world` renders the scene. `/` still renders `LiveWorkspace`: update
   `App.test.tsx`; the existing tests stay unchanged.
10. With 3 active and 1 archived screenshot, there are exactly 3 ghost buttons and the
    Crypt shows 1.
11. Clicking a ghost, or pressing Enter on its button, opens the Action Card with that
    `screenshotId` and filename, and mounts `RevivePanel` for that screenshot.
12. Clicking the Clock Tower, Library, Crypt or Portal hotspot opens its overlay at
    once, and Lumi's position is irrelevant to it.
13. Escape closes the overlay and returns focus to the opener.
14. Movement keys do nothing while focus is inside an overlay input.
15. A scripted sweep (60 s of movement plus inspect on every ghost and hotspot, using
    fake timers) records **zero** calls to `classifyScreenshot`, `startAutoProcess`,
    `requestEventDraft`, `requestMakeNotesDraft`, `setConsent` and the redo functions.
16. The Portal shows "Not connected", and the text "Delivered" never appears.
17. With `prefers-reduced-motion: reduce`, ghosts render at their slots, with no wander
    transform updates over 5 s.
18. If a scene child throws, the error boundary shows the List view link, and the
    toolbar is still usable.
19. A keyboard-only path (Tab to a ghost button, Enter, then Tab inside the card)
    reaches the card's consent controls without movement keys.

**Repository gates:**
20. `npx eslint .` fails if `src/world/scene/**` imports `src/api/*` (check by adding a
    temporary import locally).
21. The full frontend suite stays green (654 at baseline, plus the new tests);
    `tsc -b --noEmit` and `npm run build` pass; the main bundle size stays the same,
    because the world is lazy-loaded.

**Manual review (recorded):**
22. At ×2 and ×3, pixels are crisp and the composition matches M-World.
23. PRD §N-2 items 16, 17, 19 and 20 pass on the M1 build. Items 18 and 22 are
    re-checked in M2.
