# Lumi artwork for Cloud development

The 21 organized source images are byte-identical to the desktop originals. The source manifest describes their original organized-folder paths. In this checkout, find the images by filename under the five category folders in art-source. All four alternate concepts use the white wizard ghost and are included as UI references. The two source contact sheets are review documents.

## Environment and room inventory

Use the 1672 × 941 RGB graveyard, Portal Hall, and Crypt PNGs under art-source/environments as static backgrounds. They match the three desktop Cloud_Assets PNGs byte for byte. Keep the HUD, interactive controls, and player animation in separate layers.

| Room | Image | Native dimensions | Use |
| --- | --- | --- | --- |
| Upload Well | room-illustration-references/upload_well.png | 212 × 168 | Design-board crop |
| Clock Tower | room-illustration-references/clock_tower.png | 205 × 168 | Design-board crop |
| Memory Library | room-illustration-references/memory_library.png | 223 × 168 | Design-board crop |
| Approval Altar | room-illustration-references/approval_altar.png | 214 × 166 | Design-board crop |
| Portal Hall | ../art-source/environments/portal_hall.png | 1672 × 941 | Standalone background |
| Crypt | ../art-source/environments/crypt.png | 1672 × 941 | Standalone background |

The room contact sheet has four missing-background placeholders. For those rooms, the small RGB crops are from the illustrated panels of final_visual_design_board.png, inside the panel borders and clear of the adjoining controls. Inspected all four for separator, label, and UI spill. The crops preserve the panel framing and contain no upscaling. Use them as references while full-resolution clean backgrounds are missing.

Coordinates in the 1586 × 992 board, measured as left, top, right, bottom with exclusive right and bottom edges:

- Upload Well (16, 380, 228, 548)
- Clock Tower (552, 380, 757, 548)
- Memory Library (1072, 380, 1295, 548)
- Approval Altar (16, 615, 230, 781)

## Sprite and effect alpha tests

All three original sprite sheets are RGB with an embedded checkerboard. Two local tests tried a soft color key and a second pass that protected enclosed light pixels. The candidates used the native canvas and preserved source RGB. Visual checks used a dark background for all three sheets and both dark and light backgrounds for the retained ghost prototype.

| Image | Canvas | Review |
| --- | --- | --- |
| Lumi movement | 1536 × 1024 RGB | Protected masking retained pale faces and lantern cores, but left checkerboard pockets around hat charms and lanterns. Keep the source. The four directional rows are inspectable, but the header and gesture row use different spacing and landmarks. |
| Screenshot ghost states | 1774 × 887 RGB | Retained an RGBA prototype with transparent margins and preserved pale bodies. Some outline pixels and sparkles still need hand cleanup. The six rows of eight poses use variable spacing and accessory extents. Inspect each frame before slicing. |
| Magic effects | 1536 × 1024 RGB | Keying broke light gradients and left residue inside seals and soft glows. Keep the source. Portal, seal, and trail rows have different frame counts and extents. |

The prototype at alpha-prototypes/screenshot_ghost_states_alpha_prototype.png has 1,001,437 fully transparent, 24,108 partially transparent, and 547,993 opaque pixels. It is a visual-development aid. No sprite atlas, grid size, or gameplay frame coordinates are approved by this import.
