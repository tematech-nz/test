# NetMap data format (schema version 1)

A project is one JSON object. All records have stable, unique string IDs (prefix + random hex, for example
`obj_9f2c...`). Names, labels and coordinates are never used as identifiers, so renaming or moving something
cannot break a connection. Files use LF line endings and are written with 2-space indentation.

```
{
  "schemaVersion": 1,
  "id": "prj_...", "name": "...", "createdAt": ISO, "updatedAt": ISO,
  "settings": { "gridSize": 20, "snapToGrid": true },
  "counters": { "patch": 3, "fixed": 1 },          // for generated names PC-003 / FL-001
  "maps":       [ { "id", "name", "location", "viewport": { "x", "y", "zoom" } } ],
  "groups":     [ { "id", "name", "description", "location", "parentGroupId": id|null } ],
  "objects":    [ { "id", "type", "name", "location", "description", "containerId": id|null,
                    "rackHeight"?: n, "ports": [ { "id", "label", "side": "front"|"rear",
                    "portType"?, "speed"?, "media"? } ] } ],
  "placements": [ { "id", "mapId", "refType": "group"|"object", "refId", "x", "y", "w", "h" } ],
  "patchCables":[ { "id", "name", "aPortId", "bPortId", "cableType", "color", "length", "status" } ],
  "fixedLinks": [ { "id", "name", "aObjectId", "bObjectId", "cableType", "length", "route", "status",
                    "wires": [ { "id", "number", "aPortId": id|null, "bPortId": id|null, "status" } ] } ],
  "internalMappings": [ { "id", "objectId", "aPortId", "bPortId" } ]
}
```

- `type` is one of `rack`, `patchpanel`, `switch`, `router`, `internet`, `socket`, `generic`.
- `containerId` points at a group, or at a rack (racks hold patch panels, switches and generic objects).
- `internet` objects (ISP / upstream) have ordinary front ports and an optional `ipAddress` (public IP or circuit note).
- Routers have an optional `ipAddress` and ports with `"role": "wan"|"lan"` (labels `W1..`, `L1..`) and an optional
  per-port `"ip"`. IPs are free text (IPv4 with optional /prefix, or IPv6); invalid values produce validation warnings.
- Patch panels have `front` and `rear` ports and an optional `sectionSize` (ports per visual section; must divide the
  per-side port count, otherwise the automatic split is used). It is cosmetic and never affects connectivity. All other equipment has `front` ports only.
- A **placement** is the visual position of a group or object on one map. The same record may have placements
  on several maps; connection records reference object and port IDs only, never placements.
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

## Versioning and migration

`schemaVersion` is an integer. `migrate()` in `js/model.js` applies `MIGRATIONS[n]` (n to n+1) in order until the
file reaches the current version; files with a newer version are rejected with a clear message. To change the schema:
bump `SCHEMA_VERSION`, add a migration function from the previous version, add a test with an old sample file.
Files without `schemaVersion` are treated as version 0 and upgraded.
