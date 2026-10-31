# Sub-agent recent task disclosure

Primary target: src/renderer/src/ActivityDetails.tsx. Related: Island.tsx, island.css.
Mode: Operate. The user wants to click a sub-agent to inspect one concise line describing its most recent task. They confirmed concise descriptions. Preserve the black capsule, system fonts, status colors, native approval channels, task timing, dragging and docking.

## Direction contract

THESIS: Keep task status immediately visible and make the most recent task one click away.
OWN-WORLD: Inherit the black island, existing white ink roles, state colors, 34px task rows and translucent hover treatment. No visual system change.
STORY: Scan name, status and elapsed time; click or keyboard-activate a child row to reveal its latest task; activate again to collapse. Only one child opens at a time. A new task round resets disclosure.
FIRST VIEWPORT: Keep the existing task heading and four visible rows. Each child row is a native button with a small drawn chevron. The optional detail occupies one additional line below that row; long text truncates with its full text available in the title.
FORM: Local extension, code-led; no concept seed applies. Background command details keep their existing presentation.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
