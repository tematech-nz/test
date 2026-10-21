# NetMap data format (schema version 5)

A project is one JSON object. All records have stable, unique string IDs (prefix + random hex, for example
`obj_9f2c...`), made by `js/uuid.js`, which refuses to hand out an id it has already generated or loaded from a file. Names, labels and coordinates are never used as identifiers, so renaming or moving something
cannot break a connection. Files use LF line endings and are written with 2-space indentation.

## Compact form (schema 4)

Files and the browser autosave are written in a compact form; the app expands it on every load, so older (fully spelled out) files and
compact files open identically (`compactProject()` / `expandProject()` in `js/model.js`):

- **Empty optional fields are left out**: `location`, `description`, `containerId`, `ipAddress` on objects; `description`, `location`,
  `parentGroupId` on groups; `location` on maps; `length` on patch cables; `length`, `route` on fixed links; `aPortId`/`bPortId` of an
  unmapped wire; `portType`, `speed`, `media`, `ip`, `description`, `networkColor` on ports. A missing field means empty / null.
- **Straight-through panels**: a patch panel or wall socket with `"straight": true` has an internal mapping front N <-> rear N for every
  label that exists on both sides; those mappings are not listed in `internalMappings` (their ids are derived from the front port id when
  loaded, so they are stable). Panels whose mappings are not exactly that set (partial, crossed, duplicate labels) list all of them.
- The export is indented for readability and diffs; the autosave is the same data without indentation.

```
{
  "schemaVersion": 4,
  "id": "prj_...", "name": "...", "createdAt": ISO, "updatedAt": ISO,
  "settings": { "gridSize": 20, "snapToGrid": true, "gridAligned": true },  // gridAligned: layout was put on the grid (optional)
  "counters": { "patch": 3, "fixed": 1 },          // for generated names PC-003 / FL-001
  "maps":       [ { "id", "name", "location", "viewport": { "x", "y", "zoom" } } ],
  "groups":     [ { "id", "name", "description", "location", "parentGroupId": id|null } ],
  "objects":    [ { "id", "type", "name", "location", "description", "containerId": id|null,
                    "rackHeight"?: n, "ports": [ { "id", "label", "side": "front"|"rear",
                    "portType"?, "speed"?, "media"? } ] } ],
  "placements": [ { "id", "mapId", "refType": "group"|"object", "refId", "x", "y", "w", "h", "ghost"? } ],
  "patchCables":[ { "id", "name", "aPortId", "bPortId", "cableType", "color", "length", "status" } ],
  "fixedLinks": [ { "id", "name", "aObjectId", "bObjectId", "cableType", "length", "route", "status", "labelAt"?,
                    "wires": [ { "id", "number", "aPortId": id|null, "bPortId": id|null, "status" } ] } ],
  "internalMappings": [ { "id", "objectId", "aPortId", "bPortId" } ]
}
```

- `type` is one of `rack`, `patchpanel`, `switch`, `router`, `internet`, `socket`, `generic`.
- Generic equipment may carry `deviceKind` (`pc`, `laptop`, `ap`, `camera`, `printer`, `phone`, `server`; omitted = other), which only
  selects the icon and default name.
- `containerId` points at a group, or at a rack (racks hold patch panels, switches and generic objects).
- `generic` devices and managed `switch`es may carry `dhcp: true` (takes any address from its LAN; omitted when false).
- `internet` objects (ISP / upstream) have ordinary front ports, an optional `ipAddress` (address or circuit note) and an optional `publicIp: true` (the ISP gives a routable address, so the Internet can reach in; used by the Graph's "from Internet" view).
- Routers have an optional `ipAddress` and ports with `"role": "wan"|"lan"` (labels `W1..`, `L1..`) and an optional
  per-port `"ip"`. IPs are plain IPv4 strings without a prefix (schema 3 strips a `/nn` from older files); the subnet used for network warnings is assumed to be the /24. Invalid values produce validation warnings.
- Switches may carry (all optional, omitted = default): `sectionSize` (ports per section; omitted = plain rows),
  `sectionRows` (rows per section, default 1), `portOrder` (`rows`|`columns`, default `columns` when sectionRows > 1),
  `flipV` / `flipH` (true: the access-port block is mirrored upside down / left to right, e.g. 2 above 1), `align` (`center`|`right`), `uplinkSide` (`left`), `uplinkRows`, and `portIsolation` (true). Uplink ports are ports with
  `"role": "uplink"` (labels `U1..`), always listed after the access ports; `sectionSize` counts access ports only.
- Any object inside a rack or group may carry `fullWidth: true` (stretch to the container's inner width).
- Wall sockets, like patch panels, have `front` and `rear` ports with internal mappings (schema 2; files from schema 1 get rear
  ports and straight-through mappings added when imported). Fixed links join patch panels and wall sockets.
- Generic devices and switches may carry `ipAddress` (devices: used for a single-port device, per-port `ip` otherwise; switches: the
  management / web interface address). A segment is a set of devices joined by switches; routers and generic devices never bridge.
- Router ports may carry `networkColor` (hex), the default colour for patch cables extending from them.
- A fixed link may carry `labelAt: { "<mapId>": [dx, dy] }`: its label was dragged by that offset (map units) on that map.
- Any equipment with ports may carry `portGroups`: `[{ "id", "name", "color", "portIds": [...] }]` (a port is in at most one
  group; visual/organisational). A group of a **switch** may also carry `subnet` (a /24 network such as `"192.168.70.0/24"`): its ports are then a
  network of their own (a VLAN); ports in no such group are the default network and uplinks carry all of them. A group of a switch, router or generic device may also carry `deviceKind` (a device type id such as
  `camera`): a **pseudo-device** - the ports are occupied by that many unmodelled devices; the topology graph shows one endpoint
  "<name> x<ports>" and patch cables cannot be added to those ports. A group may also carry `peerId`: the id of the linked group at the
  other end of a fixed link made from it (both groups carry each other's id; names and colours are independent).
- Any port may carry an optional `description` (free text label shown on hover and in descriptions); `label` is the number
  drawn on the port's face.
- Patch panels have `front` and `rear` ports and an optional `sectionSize` (ports per visual section; must divide the
  per-side port count, otherwise the automatic split is used). It is cosmetic and never affects connectivity. All other equipment has `front` ports only.
- A **placement** is the visual position of a group or object on one map. The same record may have placements
  on several maps; connection records reference object and port IDs only, never placements. `ghost: true` marks a faded,
  non-editable copy of an item that lives (non-ghost) on another map; its size follows the real placement.
- Statuses: patch cable `planned|active|faulty|spare`; wire `connected|spare|unused|faulty`;
  link `planned|installed|faulty|decommissioned`.

## Connectivity rules

1. A port carries at most one connection: one patch cable end or one fixed wire end.
2. Patch cables join two different non-rear ports. Fixed wires join rear ports of two different patch panels
   (the link's `aObjectId` and `bObjectId`).
3. An internal mapping joins one front and one rear port of the same panel; each port is mapped at most once.
4. Nothing is inferred from grouping, racks, shared switches or map position. A trace follows only patch cables,
   fixed wires and internal mappings.
5. Wires with one or both terminations `null` are legal (spare or not yet documented) and are reported as
   warnings when half-mapped.

## Validation

`File -> Validate project` and every import report: duplicate IDs, missing references, occupied or doubly used ports,
incompatible terminations, fixed links with missing endpoints or wires on the wrong panel, duplicate wire numbers,
invalid internal mappings. Unused ports are informational only. Entries link to the affected item.

## The overview map

`auto: "all"` is the automatic "All items" map. Its placements are `ghost: true` links to the real placement of each item on the ordinary maps;
their `x`, `y`, `w`, `h` are derived (source position plus the `allOff` of the source map, `{x, y}` on that map) and rewritten on every sync, so
they never need editing by hand. Older files carry `allAt` / `allFrom` instead; they are ignored and `allOff` is rebuilt from the layout.

## Floor plans (schema 5)

A map with `"kind": "floor"` (equipment maps have no `kind`) carries a `floor` object instead of placements. Units are integer centimetres.

```json
"floor": {
  "points": [{ "id": "fpt_..", "x": 100, "y": 100 }],
  "lines":  [{ "id": "fln_..", "a": "fpt_..", "b": "fpt_..", "kind": "wall" }],
  "links":  [{ "id": "flk_..", "kind": "object", "refId": "obj_..", "x": 300, "y": 200, "rot": 0, "w": 60, "d": 100 }],
  "labels": [{ "id": "flb_..", "x": 300, "y": 370, "w": 400, "d": 60, "rot": 0, "text": "Server room", "size": 18, "color": "#0d47a1", "box": true }]
}
```

- `lines[].kind` is `wall`, `door`, `window` or `furniture`. Lines join only at points; a point lying on a line splits it. Length is derived from the points and is locked in the UI when both ends are connected to other lines.
- `links[]` reference a real item (`kind` `object` or `group`, `refId` its id). `x`,`y` is the centre, `w`x`d` the footprint, `rot` degrees. One link per item per plan. Deleting the item removes its links. Links never create connections or cable lengths.
- `labels[]` are text boxes: `x`,`y` centre, `w`x`d` box in cm, `rot` degrees, `size` in pt (1 pt = 2.5 cm of plan), `color`, optional `box` (draw a border). They carry no references.
- A tracing image used while drawing a plan is never part of the data.
- Migration 4 -> 5 adds nothing to existing maps; floor plans are simply new.

## Versioning and migration

`schemaVersion` is an integer. `migrate()` in `js/model.js` applies `MIGRATIONS[n]` (n to n+1) in order until the
file reaches the current version; files with a newer version are rejected with a clear message. To change the schema:
bump `SCHEMA_VERSION`, add a migration function from the previous version, add a test with an old sample file.
Files without `schemaVersion` are treated as version 0 and upgraded.
