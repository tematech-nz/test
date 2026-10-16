# NetMap

Offline, backend-less documentation tool for physical network cabling: groups, racks, patch panels,
switches, wall sockets, fixed multi-wire links, individual patch cables, and end-to-end path tracing across maps.
It documents cabling; it does not discover or monitor live networks.

## Install and start

No build step and no dependencies.

- Open `index.html` in a current browser (Chrome, Edge, Firefox, Safari). Works from `file://` and offline.
- Or serve the folder: `npm run serve` (or `node tools/serve.js 8080`), then open http://127.0.0.1:8080/.
- Phone: serve the folder on your LAN, or copy the folder to the phone. Use View mode on small screens.

Try it: File -> Load demo project (two rooms, a fixed link between racks, a wall socket, a trace across two maps).

## Using it

- **View mode** (default) is read-only. Search, switch maps, pan/zoom, tap anything for details, and press Trace.
  On narrow screens details and traces open in a bottom sheet and navigation in a drawer (Menu button).
- **Edit mode** (Edit button, red banner) adds the toolbar, move/resize handles, property editing and Undo/Redo.
  Objects move only by their dark drag handle (top-left); selecting never moves anything.
- **Groups** organise equipment and can nest. Moving a group moves its contents visually; deleting one asks whether
  to keep or delete the contents. Groups never imply connectivity.
- **Patch cables**: use "Patch cable tool" and tap two ports. Occupied ports and rear terminations are refused.
- **Fixed links**: installed cabling between two patch panels with N numbered wires, each mapped rear port to rear port.
  Mapping is never assumed; "sequential" is an explicit choice. Endpoints and wires change only through
  "Edit installed wiring", which shows a review of every added, deleted or changed wire before applying (one undo step).
- **Routers** (`+ Router`): choose how many WAN and LAN ports (0-96 in total, changeable later) and an optional IP
  address; every port can have its own IP too. WAN and LAN ports sit in separate strips that fold with `^`.
  Routers cable like switches and are searchable by IP.
- **Quick fixed link from ports** (edit mode, mouse): Ctrl+click free rear ports on one patch panel to group them
  (Shift+Ctrl+click extends a range). Move the pointer over another panel: the same number of rear ports, starting
  under the pointer, are highlighted (green = valid, red = occupied or not enough ports). Click to create the link
  and open its properties. Esc cancels. Wires map in port order, 1:1.
- **Patch panels** have any number of ports (1-96, e.g. 15) and show separate FRONT and REAR strips. Click the `^`
  on a strip to fold it (`v` unfolds), like a details element; cables then attach to the strip. Folding is view state
  stored in the browser only, never in the project file, and exports always show everything.
  Patch panels have front and rear terminations. Front-to-rear internal mappings are explicit records
  (the "straight-through" option or per-port mapping writes them); tracing follows only documented mappings.
- **Maps**: the same object can be shown on several maps ("Add existing here"); connections reference the shared
  object and port records. Trace results offer "open <map>" links to continue across maps.

## Saving and backup

- Autosave writes to this browser's localStorage after a short pause. It is a convenience only and is tied to the
  browser profile and origin (a `file://` copy and a `http://` copy do not share it).
- **Export JSON** (File -> Export project as JSON) is the real backup. The status bar says
  "no file backup yet" until you export.
- **Restore**: File -> Import JSON. The file is migrated and validated, you see a summary of what will be replaced,
  and nothing changes until you confirm. Export first if you need the current project.
- Other exports: SVG and PNG of a map, PDF (map images plus connection table), printable connection table.

## Data format

Single JSON document with `schemaVersion`. See [docs/DATA_FORMAT.md](docs/DATA_FORMAT.md) for the schema,
connectivity rules, and migration strategy.

## Code layout

| File | Role |
| --- | --- |
| `js/model.js` | Data model, rules, validation, search, migration. No DOM. |
| `js/trace.js` | End-to-end tracing. |
| `js/layout.js`, `js/render.js` | Geometry and SVG rendering (shared by screen and exports). |
| `js/exporters.js` | Connection table, PDF writer, download helpers. |
| `js/builder.js` | Placement helpers and the demo project. |
| `js/app.js` | UI: state, undo/redo, canvas, panels, dialogs. |

## Tests

```
npm test                      # model, tracing, validation, export logic (Node only, no dependencies)
node tests/e2e.js [shotsDir]  # browser checks with Playwright + Chromium (mobile view, edit, autosave, exports)
```

The e2e test needs `playwright` resolvable from Node (for example `NODE_PATH=$(npm root -g)`).

## Known limits (MVP)

Rack elevation views, floor-plan backgrounds, CSV import, templates, multi-user editing and live status are out of scope.
Undo history is in memory and is cleared by importing or loading a project. Very large projects redraw the whole
map on each change.
