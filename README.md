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
  On narrow screens details and traces open in a bottom sheet and navigation in a drawer (Navigation button). On desktop the same button folds the navigation column away to give the map the full width (remembered between visits; searching shows it again).
- **Edit mode** (Edit button, red banner) adds the toolbar, move/resize handles, property editing and Undo/Redo. The **History** button lists every recorded action (newest first, up to 100) so you can revert to any earlier state or move forward again to undone ones.
  Objects move only by their dark drag handle (top-left); selecting never moves anything.
- **Groups** organise equipment and can nest. Moving a group moves its contents visually; deleting one asks whether
  to keep or delete the contents. Groups never imply connectivity.
- **Safety nets for patch cables**: connecting two ports that are in different groups asks "Do you want to continue?"
  first (racks in the same group connect freely, and ports outside any group are never questioned). Hovering "Reconnect end A/B"
  circles the cable end that would move, and action buttons have tooltips explaining what they do.
- **Wire hotkey (W)**: in edit mode `W` starts the patch cable tool. If a free port is selected (or you click "Patch cable from
  here"), it draws one cable from that port and ends after the second click, leaving the new cable selected so you can set its
  colour and type at once. With nothing selected `W` toggles the repeating tool (press `W` or `Esc` to stop).
- **Port numbers and labels**: the face of a port shows its number; give a port a descriptive **label** (e.g. "Lobby camera")
  in the properties and it appears on hover, in search results and in trace/cable descriptions without widening the port.
- **Network colour**: give a router port a network colour (port properties). New patch cables that extend from it - through
  switches, patch panels and fixed links, but not through other routers - default to that colour when the patch cable tool
  is on "Auto (network colour)" (the default; pick a colour in the tool's list to override, and you can always change a single
  cable by hand). The port shows a colour bar. When you set or change the colour the app offers to **match the colours of the
  downstream cables that already exist**; "Recolour this network's cables" in the port properties does it on demand.
- **IP addresses and network warnings**: IP fields accept plain IPv4 only (four numbers 0-255; a `/24` or IPv6 is refused with a
  message). Routers have a LAN address (device IP, or per port) and optional per-port addresses. The app checks every layer-2
  segment (devices joined through switches, patch panels, fixed links and cables) and raises a **Network warnings** alert (header
  button, a red `!` on the routers, entries in the validation list) when: routers on one segment have **different subnets** (e.g.
  192.168.5.1 next to 192.168.3.1), a router **LAN port has no address** while sharing a segment with a configured one, or the
  **same address** is used twice. Several routers sharing a subnet with different addresses is fine; WAN ports without an address
  (DHCP) and the Internet side are ignored. Connecting something that would create such a warning asks "Do you want to continue?".
- **Addresses on any device**: generic devices (a one-port NVR, a PC with two NICs...) take an IP address too: a device address
  that every port without its own address inherits (shown greyed as the placeholder in port fields), or one address per port
  (192.168.3.240 on port 1, 192.168.4.5 on port 2). On the map addresses never overlap the name: a small **IP** chip in the
  corner lists all of them on hover (so does each port's tooltip). A device never joins its
  networks together - the Graph view treats it as an endpoint, so no path leads from one NIC's network to the other. **Managed
  switches** have a **Management IP** (the web interface address) which belongs to the switch's own network segment, not to any
  port. Devices and switch management addresses take part in the subnet checks (different subnet, duplicate address); devices
  without an address (DHCP) are ignored. VLANs are not modelled, so a deliberate VLAN split on one switch will show as a warning.
- **Named port groups**: give a set of ports a name and colour - e.g. rear 17-20 "to rack office" and 7-14 "L1" - and the
  ports get a colour-coded band with the name tag on the map (also in exports). Create one by Ctrl+clicking the ports (Shift for a
  range) and pressing `G`, or in the equipment's properties ("Port groups": a name, ports like `7-14, 17`, colour). Click a band to
  edit its name, colour and ports, or use "Fixed link from this group..." to start a link from exactly those rear ports. A port
  belongs to one group; groups work on any equipment with ports, are searchable, and the group name appears in the port tooltip
  and in trace/cable descriptions.
- **Placing new items**: after you fill in the "+ Switch / + Router / ..." form, the new item **follows the mouse cursor** as a
  translucent preview; click to drop it right there. Dropping on a group or rack files it into that container (the container
  is outlined in green while you hover; in a rack it stacks at the slot). **Hold Ctrl while clicking** to keep going: every Ctrl+click
  places another copy with the same settings and a counting name (Cam 1, Cam 2, Cam 3...); a plain click places the last one.
  Esc cancels, and nothing exists until you click. On a touch screen a tap drops it where you tap.
- **Cable colours**: pick white, grey, green, yellow, blue, orange, red or black from the list, or `Custom...` for an RGB
  picker. The patch cable tool has its own colour list for new cables. Cables are drawn with a thin dark outline so white and
  yellow stay visible.
- **Patch cables**: use "Patch cable tool" and tap two ports. Occupied ports and rear terminations are refused.
- **Fixed links**: installed cabling between two patch panels with N numbered wires, each mapped rear port to rear port.
  Mapping is never assumed; "sequential" is an explicit choice. Endpoints and wires change only through
  "Edit installed wiring", which shows a review of every added, deleted or changed wire before applying (one undo step).
- **Switch layout**: switches use plain rows by default. In the properties (or when creating one) choose ports per section
  and the section shape - e.g. a 16-port switch as two 2 x 4 sections (ports numbered 1 above 2, or across then down) - plus
  **uplink ports** (any number, shown in a purple block next to the sections: in line by default, left or right side) and
  **align** left / center / right to match the real faceplate. "Full width" stretches equipment to the inner width of its rack
  or group and keeps following the rack when you resize it; in a narrow rack its sections wrap onto extra lines (taller), so the rack can
  shrink down to one section wide. Switches can also have **port isolation**.
- **Port isolation** (switches): access ports cannot talk to each other, only to uplink ports. The Graph view honours it:
  devices on an isolated switch's access ports reach the uplink side but not each other directly. They can only meet by going
  up an uplink and back down (e.g. through a router, shown as a longer path through the switch twice); if nothing upstream turns
  the traffic around, they cannot reach each other at all. A U-turn on the same link is only allowed at a router.
- **Device icons**: generic equipment has a "Device type" (PC / workstation, laptop, Wi-Fi access point, camera, printer, IP
  phone, server, or other) that names it ("PC 1", "AP 1") and draws a small icon (original SVG artwork in `js/icons.js`,
  works offline and in exports).
- **Wall sockets** have a front jack and a rear termination per port, joined by an internal mapping (straight-through by
  default, like a patch panel). The rear takes installed cabling: create a **fixed link between a patch panel and a wall
  socket** (also via Ctrl+click port groups). A device plugged into the socket is traced through the outlet and the
  panel to wherever the cabling leads; in the Graph view such an outlet is just part of the cable path.
- **Routers** (`+ Router`): choose how many WAN and LAN ports (0-96 in total, changeable later) and an optional IP
  address; every port can have its own IP too. WAN and LAN ports sit in separate strips that fold with `^`.
  Routers cable like switches and are searchable by IP.
- **Internet / ISP** (`+ Internet / ISP`): a special endpoint object (default name INTERNET) with one or more ISP ports
  and an optional public IP / circuit note. Cable its ports to router WAN ports like anything else. Use several
  for multiple ISPs.
- **Graph** (header button): collapses patch cables, patch panels and fixed links into device-to-device links and shows
  the interconnection graph from a chosen device (default: INTERNET). With "To" empty you get the reachability tree
  (what can be reached, via which cables, how many hops, what is unreachable). Pick a target device to list every
  route to it, shortest first, with redundant paths highlighted. Switches and routers pass traffic through; Internet,
  wall sockets and generic devices are endpoints unless you tick "Allow paths through Internet". Subnets
  are shown on devices that have IP addresses (IP addresses are plain IPv4 such as 192.168.1.1 with no /prefix, and the subnet is assumed to be the /24 for now). Click a device or link to jump to it on the map.
  It is theoretical physical reachability: no routing, VLAN or firewall rules are modelled.
- **Quick fixed link from ports** (edit mode, mouse): Ctrl+click free rear ports on one patch panel to group them
  (Shift+Ctrl+click extends a range). Move the pointer over another panel: the same number of rear ports, starting
  under the pointer, are highlighted (green = valid, red = occupied or not enough ports). Click to create the link
  and open its properties. Esc cancels. Wires map in port order, 1:1.
- **Patch panels** have any number of ports (1-96, e.g. 15). Ports are drawn in equal sections in one line: automatic
  is 24 -> 3 x 8, 16 -> 2 x 8, 12 -> 2 x 6, 15 -> 3 x 5; choose another split in the properties (only equal splits that divide
  the port count are offered, e.g. 12 x 2 or 6 x 4 for 24). Very long panels wrap to a second line of sections. They show separate FRONT and REAR strips. Click the `^`
  on a strip to fold it (`v` unfolds), like a details element; cables then attach to the strip. Folding is view state
  stored in the browser only, never in the project file, and exports always show everything.
  Patch panels have front and rear terminations. Front-to-rear internal mappings are explicit records
  (the "straight-through" option or per-port mapping writes them); tracing follows only documented mappings.
- **Dragging into container edges**: drag an item toward the bottom or right edge of its group or rack and the container
  grows live to hold it (up to about 60 units past the edge). Drag further and the extension disappears again; drop outside
  or inside another container to move it there. Dropping inside the extension keeps the larger container.
- **Rack stacking**: dragging equipment from outside into a rack outlines the rack in green and shows a line where it will attach.
  The magnet only applies in stack-like spots: it is off when you place a device **beside** others in a row (so you can line
  devices up freely) and, for items already in the rack, it only appears at a seam between two items that are stuck together.
  A magnet drop inserts at the line and pushes what is below it down - it never re-flows the rest of the rack, and it only
  aligns the item to the left edge when the rack really is a left-aligned stack.
- **Full-width equipment** lines up with its rack on the grid (one grid step margin each side) and only moves up and down; older files are lined up and un-overlapped on load, and overlap checks use the size an item is actually drawn at.
- **Free gaps stay free**: an item dropped or created in open space between two items of a rack stays exactly there; the rack magnet only inserts it into the stack when it is dropped touching or close (about one grid step) to a neighbour.
- **Folded sections and stacking**: the layout uses an item's drawn height, so you can drop an item right under one whose Front/Rear
  section is folded. In edit mode, items stacked directly under an item (touching it, or one grid step away) follow it down or up
  when it is unfolded or folded, together with what is stacked under them in turn (one undo step).
- **All items overview**: once a project has two or more maps, an automatic map "All items" appears (not before). It shows a ghost copy of every
  item from every map, each map laid out as its own block, with the cables and fixed links between them drawn. In edit mode the ghosts can be
  dragged to arrange the overview (their positions only); nothing about the equipment can be edited there (details are read-only, no toolbar).
  In the map list it is the header (the "lid") of a box that holds all the other maps, wherever it sits in the file; the map selector lists it first.
- **One editable copy**: an item has exactly one editable placement; on every other map it is a live (ghost) copy. Older files that held the same
  item as editable placements on several maps are converted when opened (the first map keeps the editable one). Showing an item on another map
  always makes a live copy. A tap on a live copy shows it read-only, **double-click** opens the original on its own map to edit it, and Delete
  (or its red x) removes just the copy.
- **See on full map**: while a trace is shown on an ordinary map, the trace panel has a **See on full map** button that opens the All items overview with the whole route highlighted (and a **Back to <map>** button there).
- **Map order**: in edit mode every map in the map list has a dotted grab handle on its left; drag it up or down to change the order (an orange line shows where it will land). The "All items" lid always stays on top.
- **Show all links in this network** (checkbox in the trace panel): besides the route, highlights - more softly - everything else in the same network as
  the ends of the trace. A switch carries the network to all its ports and connections; with **port isolation** an access port only reaches the
  uplinks and what lies beyond them (selecting the uplink side shows everything). Routers end a network: tracing a cable between one router's LAN
  and another's **WAN** shows everything on the **downstream router's LAN**, and a LAN never leaks across a router into the WAN side. It works across maps
  (open the overview with "See on full map" to see it all).
- **Equipment list**: the navigation list shows the equipment of the current map (live copies are tagged "live copy", and items that are on no map yet "no map"); a link under it brings back the equipment of the other maps ("other map" tag). The overview lists everything.
- **Delete vs remove from map**: deleting an item that is shown on more than one map asks whether to **remove it from this map only** (it and its
  connections stay on the other maps; a group or rack is removed together with what is shown inside it) or delete it everywhere.
- **Fixed link labels** can be dragged out of the way in edit mode (per map; a dashed leader line shows where the label belongs, "Reset label
  position" in the link's panel puts it back). Labels are always drawn on top of equipment, so they never hide behind it.
- **Quick start**: File > Quick start / help (shown once automatically on the first visit with an empty project) explains the workflow,
  including that a fixed link can join panels on different maps, plus keyboard shortcuts.
- **New fixed link** shows the real rear ports of both panels: occupied ports are greyed out and cannot be picked, port groups are shown
  (click a group name to pick its free ports), Shift+click picks a range, and ports pair up in the order picked, so 1,3,5,7 on one panel can
  join 1-4 on the other. Without picking any port it still offers "N wires" (sequential or unmapped).
  **Placing a group**: click an unconnected port group's name on one panel (groups with connected ports are greyed out) - its ports are
  selected and "Place selected group" is enabled on the other panel; every run of free consecutive ports where the group fits turns
  green, the exact ports under the pointer light up (red when they do not fit), and a click there pairs them.
  **Linked groups**: a link made from a group gives the far end a group of its own (same name and colour to start with) on the other panel,
  and the two point at each other. Rename or recolour each end independently; hovering one shows the other end ("-> from rack 1 on Panel B
  (Floor 2)"), and clicking it jumps to the other end when that panel is on another map (Shift+click selects this end instead). The group's
  panel shows "Linked to" with a link and an Unlink button; deleting one end unlinks the other; copies of a panel are not linked.
- **Route optimisation** (File > Find shorter routes...): lists physical routes that detour through panels (for example panel 1 > panel 3 > panel 2) although
  a fixed link with spare or unused wires already joins two of their panels directly (panel 1 - panel 2). Each entry shows the current
  route, the shortcut link, the panels it would skip and its free wires, with a button to jump to the link. Faulty and decommissioned links are not suggested.
- **Pseudo-devices** (e.g. 16 cameras without 16 entries): make a port group (Ctrl+click ports, G, or "New group" in the equipment panel) and
  pick a **Plugged-in device** type, or set it later in the group's panel. The ports count as occupied (no patch cables), the map tag reads
  `Cameras x16`, and the Graph view shows one dashed endpoint "Cameras x16" connected to the switch. Clear the type to make the ports ordinary again.
  Links between devices that are more than one column apart are routed around the devices in between (through the free lanes between rows) instead of under them.
- **Copy / paste**: select an item in edit mode and press **Ctrl+C**, then **Ctrl+V** (or use **Copy / duplicate** in the details
  panel): the copy follows the pointer and a click drops it (Ctrl+click for more). The copy is named `Name (Copy N)` and gets the same
  settings: ports and labels, sections, port groups, internal mappings, colours. Racks and groups are copied with everything inside.
  Connections (patch cables, fixed links) and IP addresses are **not** copied.
- **No overlaps**: items inside the same container (or at the top level of a map) never overlap. A dropped, newly placed or
  resized item slides to the nearest free spot; containers grow to hold what is inside and push neighbouring
  containers away (with their contents), cascading outward. Boxes may touch, so an item can sit right under or beside another;
  new items get grid-sized boxes and sliding away keeps them on the grid. A new item's top-left corner sticks to the pointer.
  Projects made before this are put on the grid automatically the first time they are opened (positions snap to the nearest grid line,
  sizes round up so nothing becomes unreadable; marked by `settings.gridAligned`); **File > Align everything to the grid** repeats it any time (undoable).
- **Fixed link layering**: a fixed link is drawn behind every group, rack and device it does not start or end in, so it no
  longer cuts across unrelated equipment; it shows over its own endpoint groups, racks and panels and over empty canvas.
  Select the link (or trace it) to see its full length on top.
- **Selecting a fixed link, wire or patch cable** highlights its ports (yellow) on both ends, on whichever map they appear.
- **Add existing here** (toolbar) brings an item from another map to this one in one of two ways: a **ghost copy** (semi-transparent,
  not editable, mirrors every change made on its own map - name, ports, size; it takes no part in layout; tap it to jump to the
  original, remove it with its red x in edit mode) or **Relocate** (the item with its contents and layout moves here and leaves the
  other map). Items that are on no map yet are simply placed.
  A ghost is drawn with a blue dashed outline and a **LIVE COPY of <map>** badge so it is never mistaken for a separate item.
  **Move to another map...** (details panel of a group, rack or single device) cuts it with everything inside it and pastes it, editable, on
  another map or a new one - the same check applies when you relocate through "Add existing here...". It is only allowed while nothing in it is
  **patch-corded to anything outside it** ("Can't move while patch corded - only fixed links may run between maps"; the cables are listed):
  patch cables are local to a map, only fixed links may leave. Cables between things that move together (inside the same group or rack) are
  fine, so a whole group can move while a single cabled device cannot. Fixed links stay and keep a labelled stub on the old map
  ("FL-007 x3 -> Panel [Other map]").
- **Maps**: the same object can be shown on several maps ("Add existing here"); connections reference the shared
  object and port records. Trace results offer "open <map>" links to continue across maps.

### Floor plans

A second kind of map (New map -> Type: Floor plan, listed under "Floor plans") for drawing a room to scale. Units are whole centimetres (no mm).

- Tools: Select (V), Line (L), Rectangle (R). Pick what the lines are first: wall, door, window or furniture (a plain box, for example a desk). Walls are built; doors, windows and furniture are stored the same way.
- A rectangle is four lines sharing corner points. Lines may be diagonal. Where lines cross, or a line or rectangle starts or ends on another line, a point is created and the line splits there; nothing overlaps. Any line can be deleted.
- While drawing a line you can type a length in metres and press Enter. Select a line to edit its type, length and angle.
- A line whose both ends are connected to other lines cannot change length ("defined by the connected elements"): move a point instead.
- "+ Add link..." opens a search with type filters (group, rack, wall socket, generic equipment, other). Pick an item and click the plan to place it at its real size; R rotates, Esc cancels, Ctrl+click keeps placing. Double-click a link to open the real item on its equipment map. The link only references the item: the equipment keeps living on its equipment map, and its details list the floor plans it is on.
- Cable lengths are never computed from the plan.

## Updates and unsaved changes

- **New-version notice**: every build has a version stamp (a short hash of the sources: `js/version.js` is what this page runs,
  `version.json` is what the server has). When the page is served over http(s) it reads `version.json` every minute (and when you
  return to the tab). If it differs, the header shows **New version available** and a banner asks you to export your project and
  reload with **F5** or **Ctrl+R**. Nothing is ever reloaded for you. Opened from disk (`file://`) there is nothing to poll, so no notice.
- **Stamp the version** whenever you change source files before publishing: `npm run stamp` (`npm test` does it first), or enable
  the optional hook once with `git config core.hooksPath .githooks`. `node tools/version.js --check` fails when the stamp is stale.
  `npm run serve` always reports the current files' version, so local edits are noticed immediately.
- **Leave-page protection**: reloading or closing the tab with changes that were not exported to a file asks for confirmation
  (the browser autosave is not a backup). Exporting a JSON file, or importing / loading a project, clears the flag; zooming and
  folding do not set it. The flag also survives a reload, so you are asked again until you export.

## Saving and backup

- Autosave writes to this browser's localStorage after a short pause. It is a convenience only and is tied to the
  browser profile and origin (a `file://` copy and a `http://` copy do not share it).
- **Export JSON** (File -> Export project as JSON) is the real backup. The status bar says
  "no file backup yet" until you export.
- **Restore**: File -> Import JSON. The file is migrated and validated, you see a summary of what will be replaced,
  and nothing changes until you confirm. Export first if you need the current project.
- Other exports: SVG and PNG of a map, PDF (map images plus connection table), printable connection table.

## Data format

Single JSON document with `schemaVersion` (schema 5: floor plans; compact form since 4 - no empty optional fields, straight-through panels stored as a flag; the export stays indented and readable). See [docs/DATA_FORMAT.md](docs/DATA_FORMAT.md) for the schema,
connectivity rules, and migration strategy.

## Code layout

| File | Role |
| --- | --- |
| `js/model.js` | Data model, rules, validation, search, migration. No DOM. |
| `js/trace.js` | End-to-end tracing. |
| `js/floor.js` | Floor plan geometry engine (points, lines, splitting, locked lengths, links). |
| `js/layout.js`, `js/render.js` | Geometry and SVG rendering (shared by screen and exports). |
| `tools/version.js`, `tools/serve.js` | Version stamp (`version.json`, `js/version.js`) and the optional dev server. |
| `js/exporters.js` | Connection table, PDF writer, download helpers. |
| `js/builder.js` | Placement helpers and the demo project. |
| `js/topology.js`, `js/graphview.js` | Device-level graph, reachability tree, path search and the Graph view. |
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
