# Pixel World review handoff

Branch: `feature/pixel-world-frontend` (local, not pushed). Base: `53b0f6b`.
Commits: `e366d21` playable scene, then the overlays and QA commit on top (see `git log 53b0f6b..HEAD`).
Backend, database schema and deployment security files are untouched (`git diff --stat 53b0f6b -- backend` is empty).

## Completed

- `?view=world` route, lazy loaded; the default route is unchanged.
- Scene: Lantern Graveyard, Lumi (WASD/arrows, E to interact, collisions), a ghost per active screenshot, crowd marker above 24, HUD, List view link, and an error boundary around the scene (the toolbar stays usable).
- Overlays (one at a time, Escape closes, focus returns to the opener, movement keys ignored inside overlays): Action Card, Quick Queue, Clock Tower (calendar), Library (notes), Upload Well, Approval Altar, Crypt, Portal, Settings.

## Real versus mocked

| Area | Live mode (backend running) | Demo mode (`demo=1`, or backend unreachable) |
|---|---|---|
| Ghost list | Real `GET /api/screenshots` (read only) | Synthetic fixtures, labelled |
| Action Card | Existing `RevivePanel`, `MakeNotesDraft`, `CalendarDraft` with the same props as the list view. Opening only reads. Paid calls only from the user's own clicks inside those components | Labelled prototype text; no API calls |
| Clock Tower / Library | Pick an analyzed screenshot; opens its card with Add to Calendar / Make Notes pre-chosen. Nothing starts until Prepare is pressed | Prototype card |
| Quick Queue | Real ghost list | Synthetic list |
| Upload Well | Existing `UploadDropZone` and `uploadScreenshots` (user action) | Disabled, labelled prototype |
| Approval Altar | Cannot list approvals (no list endpoint). Links to cards, where real approval lives. Stamp preview is a labelled animation only | Invented approval states, labelled; stamp preview |
| Crypt | Real archived list; saved drafts read-only via `ArchivedDrafts`; Resurrect uses the existing `restoreScreenshot` on click, then re-reads the list (also after an unconfirmed result) | Synthetic list, Resurrect disabled |
| Portal | "Not connected" prototype. Never claims a send | Same |
| Settings | Provider badge and `AutomationToggle` (existing server preference) plus List view link | Explanatory note, no calls |

No Google OAuth, Notion delivery, new endpoints, or real AI calls are included.

## Tests

- Final gate: `npx tsc -b --noEmit`, `npm run lint`, `npx vitest run` (43 files, 689 tests at the last run) and `npm run build`.
- New tests in `src/world/PixelWorld.overlays.test.tsx` cover milestone items 11 to 19: card opens with RevivePanel, hotspots open overlays, Escape focus return, no movement inside overlay inputs, zero paid calls across a sweep, demo mode makes zero API calls, Portal never says delivered, reduced motion, error boundary with List view link, keyboard path to the consent controls.
- A demo-mode test caught a real bug: the Crypt read the AI provider mode even for synthetic data. Fixed.

## Browser QA

Playwright drove the headless Chromium shell in `/inner_container/opt/playwright/chromium_headless_shell-1232` (the full Chrome binary crashes under crashpad; the headless shell works). Script: `docs/screenshots/pixel-world/qa-script.mjs`. Output: `docs/screenshots/pixel-world/qa-report.txt`.

At 1280x720 and 390x844 in demo mode: Lumi moved, a ghost card opened, every overlay opened and closed with Escape, focus returned to the opener each time, no horizontal overflow, 0 console errors or warnings, 0 `/api/` requests, Portal says "Not connected" and never "delivered".

Screenshots (synthetic data only): `docs/screenshots/pixel-world/`.

Not browser-tested: live mode against a real backend (none was run). Revive, drafts, upload and resurrect are covered by mocked unit tests only.

## Preview

```
cd frontend
npm run dev
# open http://localhost:5173/?view=world&demo=1   (add &ghosts=40 for a crowd)
# with the backend running, drop demo=1 for live data
```

## Remaining issues

- Approval Altar has no real data until a read-only approvals summary endpoint exists.
- Bury is not offered in the world. Resurrect does not use the list view's `useLifecycle` reconciliation; it re-reads the list instead.
- AutoPilot is not hosted in the card.
- Art is generated placeholder pixel art (`manifest.json` flags it).
- Live-mode visual QA with real data still needs a human pass.

## Suggested review order

1. `desktop-01-world.png`, then play it with the preview commands.
2. Action Card (`03`), then Quick Queue, Clock Tower, Library.
3. Upload Well, Crypt, Approval Altar.
4. Portal and Settings.
5. Narrow (390px) screenshots.
6. Live mode with the backend, in a scratch workspace.
