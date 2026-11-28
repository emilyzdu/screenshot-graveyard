# Lumi asset manifest

Source: original Lumi art folder. Reviewed all 21 images visually. Every organized source image is a byte-identical copy. SHA-256 found no exact duplicates. No black-cat Lumi concepts were found, so 08_deprecated/ is empty.

**Art direction.** Lumi is a white magical ghost with a purple wizard hat and golden lantern. Use full-screen midnight-blue and wisteria backgrounds with the floating HUD, sprites, text, and controls in separate layers.

**Status.** A production-ready background can be used as a static backdrop today. Reference art contains baked-in controls or sprite frames requiring preparation. Alternatives are visually distinct variants.

| Original PNG filename | Organized PNG path | Category | Dimensions | Transparency | Intended usage | Readiness | Duplicate or alternative status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `f8b4675e-91ce-44aa-aacb-1e6637272d15.png` | `01_world/graveyard_clean_background.png` | World | 1672 × 941 | Opaque RGB | Primary full-screen backdrop. Add player, screenshot ghosts, and HUD as separate layers. | Production-ready background | Unique SHA-256, selected |
| `01-graveyard-world.png.png` | `01_world/graveyard_ui_reference.png` | World | 1672 × 941 | Opaque RGB | Full-screen world and floating corner HUD with Lumi and screenshot ghosts. | Reference only | Unique SHA-256, selected |
| `b0f84206-5995-4e93-9d96-0fdcfd829c2a.png` | `02_room_backgrounds/crypt.png` | Room backgrounds | 1672 × 941 | Opaque RGB | Static Crypt backdrop with tombstones and decorative engravings. | Production-ready background | Unique SHA-256, selected |
| `499446b1-616e-444e-bfd5-1e3f5c315dbf.png` | `02_room_backgrounds/portal_hall.png` | Room backgrounds | 1672 × 941 | Opaque RGB | Static Portal Hall backdrop. Portal emblems are painted into the architecture. | Production-ready background | Unique SHA-256, selected |
| `0d5cf206-fef9-425a-b2cc-64596ee58cd0.png` | `03_characters/lumi_movement_sprite_sheet.png` | Characters | 1536 × 1024 | Opaque RGB, baked checkerboard | Canonical white wizard ghost with purple hat and golden lantern. Includes a large reference pose, four travel directions, and expressions. | Reference only | Unique SHA-256, selected |
| `7917ef98-2948-4485-8d4c-4b80556f6804.png` | `03_characters/screenshot_ghost_states_sprite_sheet.png` | Characters | 1774 × 887 | Opaque RGB, baked checkerboard | Screenshot ghost state and animation rows for lifecycle styling. | Reference only | Unique SHA-256, selected |
| `17beaa09-9f86-4d6c-a609-2e9f3976f122.png` | `04_effects/magic_effects_sprite_sheet.png` | Effects | 1536 × 1024 | Opaque RGB, baked checkerboard | Summon rings, portal frames, screenshot trails, approval seals, lanterns, and sparkles. | Reference only | Unique SHA-256, selected |
| ` 03-approval-portal.png` | `05_ui_references/action_card_ui.png` | Ui references | 1672 × 941 | Opaque RGB | Floating screenshot interpretation, draft choices, and approval action. | Reference only | Unique SHA-256, selected |
| `dd173d27-7e19-40f5-a5c4-9d05a4bf8ada.png` | `05_ui_references/approval_altar_ui.png` | Ui references | 1672 × 941 | Opaque RGB | Approval Altar with painted-in preview, checklist, and confirmation controls. | Reference only | Unique SHA-256, selected |
| `4a8d9c9c-24d3-428c-84bf-5569a96f1fde.png` | `05_ui_references/clock_tower_ui.png` | Ui references | 1672 × 941 | Opaque RGB | Clock Tower with baked-in calendar and schedule cards. | Reference only | Unique SHA-256, selected |
| `eaa38f18-14a2-47f8-ac8c-6c4b9f2ca6e4.png` | `05_ui_references/crypt_ui.png` | Ui references | 1672 × 941 | Opaque RGB | Archive search, illustrative entries, and painted-in Restore controls. | Reference only | Unique SHA-256, selected |
| `e3a10136-17d3-4130-bdac-5413f4950cbb.png` | `05_ui_references/memory_library_ui.png` | Ui references | 1672 × 941 | Opaque RGB | Memory Library with painted-in search, notes surface, and destination cards. | Reference only | Unique SHA-256, selected |
| `758fad08-f096-431e-9cf3-ee106448acf6.png` | `05_ui_references/portal_ui.png` | Ui references | 1672 × 941 | Opaque RGB | Portal Hall with baked-in connected-app labels, execution log, and illustrative receipt. | Reference only | Unique SHA-256, selected |
| `abfc23b8-60ab-4edc-abb5-f766d67f519e.png` | `05_ui_references/quick_queue_ui.png` | Ui references | 1586 × 992 | Opaque RGB | Queue groups, review actions, and status hierarchy. | Reference only | Unique SHA-256, selected |
| `238223c4-3859-42a8-9aa2-52b761838714.png` | `05_ui_references/settings_ui.png` | Ui references | 1586 × 992 | Opaque RGB | Open-book Settings with labeled audio, controls, accessibility, and privacy sections. | Reference only | Unique SHA-256, selected |
| `e0d95b6e-e9b9-49aa-b42a-6643d4d8bf83.png` | `05_ui_references/upload_well_ui.png` | Ui references | 1672 × 941 | Opaque RGB | Upload Well with painted-in drop zone, checkbox, and progress bar. | Reference only | Unique SHA-256, selected |
| `562685e0-eacf-4194-bf12-cd8d9d913b92.png` | `06_design_boards/final_visual_design_board.png` | Design boards | 1586 × 992 | RGBA, alpha 7–252, no fully transparent pixels | Reference for the HUD, six rooms, Lumi, screenshot ghost states, icons, and effects. Example statuses are illustrative. | Reference only | Unique SHA-256, selected |
| `  02-ai-action-card.png` | `07_alternatives/approval_delivery_overlay_alternative.png` | Alternatives | 1672 × 941 | Opaque RGB | Alternate approval-to-delivery sequence with an action card and receipt. | Reference only | Unique SHA-256, alternative |
| `The Lantern Graveyard at Midnight.png` | `07_alternatives/graveyard_framed_demo_hud_alternative.png` | Alternatives | 1672 × 941 | Opaque RGB | Alternate framed game display with demo label and keyboard hints. | Reference only | Unique SHA-256, alternative |
| `1dfdb5f9-e841-49a9-99b8-1555253b0d6b.png` | `07_alternatives/quick_queue_unlabeled_overlay_alternative.png` | Alternatives | 1672 × 941 | Opaque RGB | Alternate floating queue shell with placeholder rows. | Reference only | Unique SHA-256, alternative |
| `7c363ce1-b1db-44af-92cf-3bb9e3436d9b.png` | `07_alternatives/settings_unlabeled_book_alternative.png` | Alternatives | 1585 × 992 | Opaque RGB | Alternate book layout with icon-only tabs and placeholder controls. | Reference only | Unique SHA-256, alternative |

## Missing and combined assets

- **Clean room backgrounds missing.** upload_well.png, clock_tower.png, memory_library.png, and approval_altar.png. Their available counterparts are in 05_ui_references/ with baked-in controls.
- **Standalone Lumi reference missing.** The large canonical pose is embedded in 03_characters/lumi_movement_sprite_sheet.png. No separate lumi_character_reference.png was created.
- **Standalone animation references missing.** Portal and approval sequences are in 04_effects/magic_effects_sprite_sheet.png. No separate portal_animation_reference.png or approval_animation_reference.png was created.
- **Runtime sprites and effects missing.** The Lumi, screenshot ghost, and magic effect sheets have opaque baked-in checkerboards. True-alpha, aligned frames still need preparation.

## Cloud UI implementation

Use the three PNGs in the sibling Cloud_Assets folder as static backgrounds:

- graveyard_clean_background.png for the full-screen hub.
- portal_hall.png for the Portal room.
- crypt.png for the archive room.

Consult graveyard_ui_reference.png and final_visual_design_board.png in the organized folder for the floating HUD and navigation. These are design references. Cloud_Assets contains only the three runtime backdrops.

## Generated review sheets

- CONTACT_SHEET.png contains all 21 organized source images with their new filenames.
- 02_room_backgrounds/room_backgrounds_contact_sheet.png contains two clean room backgrounds and four explicitly marked missing slots.
