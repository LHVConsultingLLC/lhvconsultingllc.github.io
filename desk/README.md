# LHV Field Log · Desk (laptop)

Build `desk-p2`, 2026-10-11. **Go-live ready, not deployed.** Deploying it is Dustin's decision.

## What it is

The field-log phone, moved onto the driver's laptop. One full-screen browser window:

- **Left 1/4: the field log.** Counters, the SHIP gate, a big **NEXT TO DRIVE** address bar, the
  field card for the selected parcel (read-only AI panel, NVFR / No Photos / Flag for Admin Review,
  and an **▣ Aerial** button), then the list in drive-file (seq) order.
- **Right 3/4: the map.** Pins numbered by seq and coloured by status, the driver's live position
  (USB GPS puck), and a fixed **address banner** at the top: the NEXT parcel and the parcel the
  camera is on, street in large type with the city under it.

The driver carries **one phone (the camera)** plus the laptop. The desk uses the same driver key
and the same RTDB nodes (`sessions/<DRIVER>/…`) as `docs/index.html`, so the camera cannot tell
the desk from the old field-log phone.

Files:

| File | What |
|---|---|
| `docs/desk.html` | the page (all logic inline; sections numbered 0 to 13) |
| `docs/desk-sw.js` | its service worker: offline shell + passive map-tile cache. Scope `./desk`, so it never touches index.html or camera.html (they keep `sw.js`) |
| `docs/desk/vendor/` | Leaflet 1.9 + SheetJS, served locally so the page opens with no signal |
| `docs/desk/mock.js` | test harness only (mock server, mock camera, mock NMEA puck) |
| `docs/desk/route.js` | offline routing module, loaded only with `?route=1` (see *Route here* below) |
| `docs/desk/imagery.js` | offline map packs: `<bucket>.imagery.pmtiles` + `<bucket>.streets.pmtiles` (see *Offline map packs* below) |
| `docs/desk/README.md` | this file |

## How to open it

1. **Chrome or Edge** on the laptop (Web Serial for the puck and the folder picker need them).
2. Open `https://lhvconsultingllc.github.io/field-log/desk.html?key=<DRIVER KEY>` once. The key is
   saved on the laptop and removed from the address bar (same as the camera link). After that
   the plain URL is enough. Bookmark it.
3. Type the initials (RF), press **Open today's drive file folder…** and pick
   `Dropbox › … › LHV Consulting Work › _COUNTY ENGINE › DRIVE FILES › <COUNTY>`
   (the folder holding `<COUNTY>.xlsx` and `aerials/`). Chrome remembers the folder;
   next time it offers **Reopen <COUNTY>**.
4. Plug in the GPS puck and press **Connect GPS puck** once (Chrome asks which port: the
   Prolific one). After that it reconnects by itself on every load.

If the key's driver differs from the typed initials, the key wins (the database rules only let
`driver_XX` write `sessions/XX`).

## Screen controls

| Action | Mouse | Key |
|---|---|---|
| Next / previous parcel | click a row or a pin | ↓ ↑ (or J K) |
| Same-address parcels | one pin and one row at the lowest seq ("230 +1"), colour = worst member; the card lists every member | |
| Centre map on selected | | Enter |
| Jump to the camera's parcel | click the pink banner block | C |
| Aerial, full height | **▣ Aerial** on the field card | A (A, Esc or a click closes; ↑ ↓ walk the list while it is open) |
| NVFR / No Photos / Flag | the three card buttons | N / P / F |
| Log minimized to a strip (seq, NEXT + camera address, counters, link) | **–** in the log's top bar; click the strip to open | L |
| Log full screen | **⤢** in the log's top bar | Shift+L |
| Map full screen | **⤢** under the map zoom buttons | Shift+M |
| Back to the 1/4 : 3/4 split | **⇆ Split** / double-click the divider | 0 |
| Map: Streets → Imagery → Grid | Map panel | M |
| Floating map panels (address banner, Position, Map) | **–** shrinks each to a small tab; click the tab to reopen | |
| Show only To drive / Incomplete / … | click a counter | 1 to 6 |
| List order: drive-file order / needs attention first | the drop-down beside the search box | |
| SHIP (asks first) | SHIP | S |
| Route here (only with `?route=1`): turn-by-turn to the selected parcel | **↝ Route here** on the field card | R |
| Stop the route | **■ Stop** on the route banner (or **■ Stop route** on that parcel's card) | Esc |

The split width, the layout (split / log strip / log full / map full) and every minimized panel
are remembered on the laptop.

**Parcel outlines.** If the county folder holds `<bucket>.boundaries.geojson` (FeatureCollection of
Polygons, properties `{seq, pid}`, WGS84), the desk stores it in IndexedDB per bucket and draws the
**selected** and **NEXT** parcels' lots in yellow (`#FFD400`, 3 px, dark halo, no fill; reads on Imagery
and Streets); at zoom 17+ every other lot in view is a thin white line. Keyed by **parcel ID**, never
seq. No file = no outlines, nothing else changes. The nightly builder patch that writes the file is
staged at `functions/_staged/desk_boundaries.patch` (not applied; a separate decision).

**Finished dots leave the map on their own** (Dustin 10/11, replacing Maptitude's manual delete);
**Show driven** in the Map panel (row *Driven*) brings them back, dim; remembered on the laptop.

**Drive-file facts on the card:** Acres · Market value, Owner (small), a click-only **Parcel map ↗**
link, and a **⚠ Pin may be off** chip only when Accuracy / Accuracy Detail / Boundary Note has text.
`OrderedBy` and `Client Ref` are not even read (a driver never sees who ordered a parcel).

**BATCH:** two or more seqs at the same street + city show **BATCH · seqs 230, 231** on the card
and in the list (the driver calls them as a batch).

**Narrow and short screens.** The log pane is never narrower than 290 px. Below 520 px the counters
are a 3 × 2 grid with full labels; below 400 px the SHIP button stacks under the upload banner and the
key hints on the card buttons hide. No address, county name or label is ever ellipsized: they wrap,
and the map banner's NEXT / CAMERA blocks stack when the map is narrow. The ▣ Aerial button sits on the
SEQ line and wraps under it when there is no room. On short screens (≤ 780 px) everything tightens;
if it still does not fit (e.g. 986 × 695) the log pane scrolls instead of clipping. Tip for drivers:
F11 (true full screen).

**NVFR** (Dustin 10/11: "nvfr has photos just photos of what we can see"): the tap only marks NVFR
(`unoccupied/boardedUp/burnedDown/tornDown`, as index.html toggleNvfrAll). It does not close the parcel;
it completes when the camera's photos land, exactly as on the phone.

**NO PHOTOS = rated, not photographed** (Dustin 10/11: "We will need give ratings to close it. We can see
it. We just can't take photos because of kids or safety."). On a parcel the camera never opened, **No
Photos** (or P) opens a small panel under the card (not a modal): **Rating** 0–5 in halves (keys 0–5, `.`
for half; required) and **Reason**: Kids (K) / Safety (Y) and/or a few typed words (one required). Land use
comes from the drive file's Land Use. **Save** (Enter) writes through the outbox (works with no signal):
`noPhotos:true`, `build` = the rating, `landUse`, `comment` = `[NO PHOTOS] SAFETY` / `[NO PHOTOS] KIDS
PRESENT` / `[NO PHOTOS] <TYPED TEXT>` (the phone's tag and upper-case convention), plus the phone's close
(`closed`, `closedAt`, `driveDate`, `touched`), so the mirrored `logHasMissingData` calls it complete: the
card and list show **Driven** with the rating marked *driver's rating*. Clearing No Photos reopens it
(`closed:false`, and the desk's rating + `[NO PHOTOS]` comment are taken back) → *To drive*. A parcel with
photos keeps the plain No Photos flag toggle.

The aerial **never opens by itself** (Dustin 10/11): only from the field card's **▣ Aerial**
button or the **A** key. Pins show their seq; hovering a pin shows its address; the selected,
NEXT and camera parcels carry their address label permanently.

"NEXT to drive" = the lowest-seq parcel still to drive after the one the camera is on, in
drive-file order (the drive file's order is the plan). It is a display suggestion only: it never starts a route.

## Offline and the hotspot

The phone's **Personal Hotspot is the default link**. The laptop joins it; the camera phone uses
its own cellular. When the phone has no signal, neither does the laptop.

**Works with NO signal (everything is on the laptop):**
- the day's list, coordinates, statuses (last snapshot), counters, the NEXT address
- every aerial (copied into the browser's own storage when the folder is opened; stored by
  **parcel ID**, so the nightly seq renumbering can never show the wrong picture)
- the parcel outlines (`<bucket>.boundaries.geojson`, same rule)
- the map pins and the GPS dot (the puck needs no signal); the **Streets map of the whole county**
  and **sharp imagery near every parcel** when the county folder holds the two map packs (below);
  otherwise map pictures for areas already viewed while online (the service worker keeps them).
  With no map pictures at all the map falls back to a coordinate grid: pins, dot and labels still show.
- NVFR / No Photos / Flag taps: saved on the laptop first (IndexedDB **outbox**), shown at once,
  and replayed **in tap order** when the link returns. The pill reads **○ Offline · N changes
  waiting**, the card says **⏳ N change(s) saved on this laptop, waiting for signal**, and closing
  the tab warns while anything is waiting. A reload with no signal reopens the day from the laptop.

**Needs the hotspot:** live statuses and AI ratings from the camera/server, the camera
heartbeat ("Camera linked"), sending queued taps, publishing the job to the camera, and **SHIP**
(refused offline, nothing is lost).

**The camera on its own:** shoots, queues and uploads photos on its own signal exactly as today.
While the laptop is offline the camera keeps working; when the laptop reconnects it catches up
from the server (tested: a parcel shot during the outage appeared, Driven, on reconnect).

### Offline map packs (`docs/desk/imagery.js`, built by `tools/imagery_pack_build.py`)

Two files per county, in the county folder or in `_COUNTY ENGINE/_IMAGERY/<bucket>/` (the desk
asks once for the `_IMAGERY` folder: **Choose the _IMAGERY folder…** under *Saved on this laptop*).
A pack under 300 MB is copied into IndexedDB as **one blob** when the county loads (again only when
the file changed). A bigger one (a whole-county road corridor is GBs) is **never copied**: it is
read in place from the laptop's Dropbox folder with range reads, so that folder must be set to
*Available offline* in Dropbox. Same format for both (PMTiles v3, JPEG tiles); no file = nothing changes.

| File | What | Built with |
|---|---|---|
| `<bucket>.streets.pmtiles` | USGS Topo (The National Map, public domain), z10-z16, **whole county** +500 m (Census TIGER polygon). Streets mode draws it over the online tiles (which skip what it has), overzoomed to 18; Imagery mode keeps it underneath, so the map is never black | `--streets COUNTY.geojson OUT --bucket B` |
| `<bucket>.imagery.pmtiles` | USDA NAIP (public domain) via Microsoft Planetary Computer, z17-z19 JPEG, ±50 m of each parcel outline (or pin). Drawn above the live NAIP layer on Imagery, overzoomed to 20; NAIP Plus is only the per-tile fallback | `BOUNDARIES.geojson\|DRIVE.xlsx OUT` |

The imagery builder also has a whole-county **road-corridor** mode (`--corridor`, ±100 m of OSM
roads), `--count`, `--estimate N` and `--workers N`. Builds are incremental (a list build after a
corridor build fetches only what is missing) and resumable: tiles go into `<pack>.work.sqlite` as
they arrive and `<pack>.progress.json` shows done / rate / ETA; rerun the same command to resume. The capture
dates are in the pack and show in *Saved on this laptop*. Imagery on Imagery mode at z16+ sits on
USGSImageryOnly (no contour labels); further out USGSImageryTopo (road names).

## What the desk writes (all under `sessions/<DRIVER>/`, same as the phone)

- **Job identity** when a county is loaded (mirrors `index.html` startSession + `fbWriteJob`):
  `jobFolder`, `jobLabel`, `jobKey`, `jobMeta`, `photoRoot`. Without these the camera shows
  "No Active Job" and files photos under the previous county. On a **proven different job**
  (the session's `jobFolder` names another county) it first does the phone's clean slate:
  `logs`, `shipped`, `aiComments`, `aiRatings`, `aiRequests` cleared, `photoCounts` emptied,
  `resetNonce` bumped. Same county = nothing wiped.
- `masterSeqs` (the camera's seq list, already-driven parcels withheld, same lite shape), only
  after the job identity has landed.
- `hbRec` every 5 s (the camera's "recorder alive" heartbeat).
- Driver taps via the outbox: `logs/<seq>` NVFR (`unoccupied/boardedUp/burnedDown/tornDown`),
  `noPhotos`, `flagged`, stamped with `parcelId` + `bucket`. Absolute values only.
- **Evidence close** (the phone's `_evidenceCloseSweep`): a parcel with a rating (or the AI's) and
  every photo confirmed is closed, via the outbox, plus a `heardLog` line.
- **SHIP**: `shipped/<seq>` + `logs/<seq>/shipped|shippedAt`, read back before claiming success.

### Camera leads, laptop follows (Dustin 2026-10-15)

The laptop never sends a parcel to the camera. Tap-to-camera, BATCH / MULTI from the laptop and the
camera's no-mic "laptop loop" were removed on 10/15. The camera leads by voice (LOCK) and the laptop
follows its `active`, through the server and, with no signal, down the direct line (`desk/p2p.js`).
An old `seqRequest` item left in a laptop's outbox is dropped unsent.

## Needs Dustin's decision

1. **Ship-time RAW merge file.** The phone also writes `JOB DATA/…/RAW/<FPL>_DRIVER-RAW.xlsx` to
   Dropbox at SHIP. The desk has no Dropbox login, so it does not. No Cloud Function reads that
   file (grepped `functions/`); the client workbook is built server-side. Confirm it can go.
2. **No "close" button.** NVFR / No Photos on a parcel the camera never locked leaves it
   *To drive*; closing a no-photo parcel is the camera's job (camera.html ~line 8370). Confirm.
3. **Counters.** The desk's *To drive* excludes parcels that are uploading or rating; the
   phone's Pending tile includes them. Separately, in both, the *Uploading* tile only counts
   parcels that already have a rating, so under the AI flow a parcel shows *Rating…* while its
   photos upload.
4. Do not commit `_desk_mock/` (real Greenville rows with owner names and the ordering client).
5. ~~NVFR / No Photos → Driven~~ — answered 10/11 (NVFR completes on photos; No Photos is rated on the
   desk, above). Open detail: the No Photos comment keeps the phone's `[NO PHOTOS]` tag.

## Routing: Route here (`docs/desk/route.js`, only with `?route=1`)

**Dustin 10/11: "I don't want auto routing."** Routing is only ever started by the driver:

- **Every parcel card has ↝ Route here (key R).** Click a pin or a list row, press it: offline
  turn-by-turn to **that parcel only**. The route banner (under the address banner) shows
  **ROUTING TO ▸ SEQ n**, the full street address in big type (wraps, never cut off), distance and
  time by road, the next turn ("In 0.3 mi: Turn left onto …"), and **■ Stop** (Esc).
- **The route ends by itself** when that parcel is shot (its status leaves *To drive*, or the camera
  goes onto it), when Route here is pressed on another parcel (the target switches), or on Stop.
  It **never** chains to the next stop. After it ends there is no route until the driver presses
  Route here again.
- **Retired (deleted, not hidden):** the AUTO mode, the auto distance, Shift+R AUTO, and route-to-NEXT.
  "Next to drive" (bar, banner, NEXT pin label) is a display suggestion only and never starts a route.
- **Wrong turn:** off the route by 60 m for 3 fixes → it reroutes to the same parcel; heading the
  wrong way along it shows "Turn around when safe — then …".
- **Road file:** `DRIVE FILES/<BUCKET>/<BUCKET>.roads.json`, beside the drive file. Opening the folder
  copies it into the laptop (IndexedDB, per bucket); it is read only when Route here is pressed.
  No file → the banner says **"No road file for this county"** and nothing else changes. Built from
  OpenStreetMap with `tools/route_graph_build.js` (© OpenStreetMap contributors, ODbL; the attribution
  shows on the banner and the map). Greenville test file (mock only, `_desk_mock/SC_GREENVILLE/`, built
10/11 from 14 Overpass boxes): 10.4 MB (3.3 MB gzipped), 108,727 junctions, 135,923 road pieces, loads in
about 0.15 s; all 560 mock parcels snap to a road and route.
- **No module, no button:** without `?route=1` (or if route.js fails to load) the card has no
  Route here button and R / Esc do nothing new.

How it plugs in: `window.DeskAPI` (desk.html section 13) → `DeskRoute.attach(DeskAPI)`:

- read: `rows()`, `listable()`, `status(seq)`, `latlng(row)`, `job()`, `currentSeq()`,
  `cameraSeq()`, `online()`, `position()`, `map()` (the Leaflet map to draw on), `roads()` (this
  county's road file, or null)
- subscribe: `onRender(fn)` after every redraw, `onPosition(fn)` on every GPS fix
- act: `select(seq)`, `cardAction(spec)` (the one card button + its key + Esc), `slot(show)` (the
  minimizable route banner), `refresh()`, `toast(msg)`, `setNextProvider(fn)` (overrides the NEXT
  display; route.js does not use it)

Mock test panel with `?route=1`: **Wrong turn** (the mock puck leaves the route down a side road) and
**Camera: shoot route target**. With a route running, Mock NMEA drives that route's roads.

`docs/desk/route-test.html` (standalone, MapLibre + a `.pmtiles` map file) follows the same rule:
click a pin, Route here (R), Stop (Esc); its simulated driver drives only the routed parcel and stops.

The desk's own early route-line / distance HUD / tile-prefetch prototype is still switched off
(`?routing=1` shows it, for comparison only; it draws a straight line, never a route). Known constraint
from 10/10 in Harrison: Google Maps links need signal; the puck + cached coordinates work offline; bulk
tile download is limited by each tile source's terms (OpenStreetMap's servers forbid it; the desk's map
is USGS The National Map, public domain).

## Replacing Maptitude (about $2k a year, Dustin's figure)

| Drivers use Maptitude for | desk.html |
|---|---|
| Live position from the BU-353N5 puck | ✓ Web Serial, 4800 baud NMEA (GP and GN sentences); fallback = laptop location |
| Seeing the day's parcels on a map | ✓ pins by seq + status, list ↔ map selection, address labels |
| Plotting our lat/long (road-frontage coordinate) | ✓ the drive file's coordinates are the pins |
| Which parcel is next / where it is | ✓ NEXT address bar + map banner (drive-file order) |
| Routing / turn-by-turn | `?route=1`: **Route here** per parcel, driver-started only (prototype) |
| Working with no signal | ✓ list, pins, dot, aerials, taps; map pictures only where already viewed |

Only one program can read the puck at a time: close Maptitude before pressing Connect.

## Path to one phone

Dustin: the laptop is a step; the end state is one phone. Built to move:

- **As-is:** the status rules (section 3), the outbox + IndexedDB store (1, 5), the listeners and
  job publishing (6), the aerial cache (by parcel ID), the Leaflet map + pins (9), and DeskAPI.
  None of them depend on the desk layout.
- **Would change:** the layout (one column, the map as a tab); the folder picker (a phone has
  none; the list and aerials would come down from Dropbox, as index.html already does); the
  position source: the camera phone's own GPS instead of the USB puck (**not approved yet**,
  not built).

## Docking (optional)

The desk is its own 1/4 : 3/4 split in one full-screen window, so no docking app is needed.
Only for someone keeping Maptitude beside it:

- **Windows, PowerToys FancyZones:** install Microsoft PowerToys → FancyZones → *Launch layout
  editor* → *Create new layout* → *Columns*, 2 zones → drag the divider to 25 % / 75 % → Save
  and apply. Hold **Shift** while dragging a window to drop it into a zone.
- **Windows 11 Snap Layouts (no install):** hover the window's maximize button and pick a
  two-column layout (Snap has no 25/75; 1/3 : 2/3 is the closest).
- **Mac:** Rectangle (free): *First Fourth* / *Last Three Fourths*.

## Testing

`python3 -m http.server 8899` in `~/fieldlog` (launch config `fieldlog-preview`), then
`http://localhost:8899/docs/desk.html?mock=/_desk_mock/SC_GREENVILLE` (add `&asof=2026-10-12`
to pretend the AI cutover has happened). Mock mode loads `desk/mock.js` and never loads
Firebase. **Mock only runs on localhost and only with `?mock=`**; on the live site
`desk/mock.js` is never even requested. Purple test panel: drop/restore the link, shoot the next
parcel, auto camera, seed a morning, mock NMEA, reset.

Results 2026-10-11 (mock): plain `desk.html` loads no mock (no request, no panel, no data) ✓ ·
list ↔ map selection both ways ✓ · statuses through shoot → Rating… → Driven, NVFR, Incomplete ✓ ·
aerial button / A / Esc / click, nothing auto-opens ✓ · offline: 3 taps queued, pill + card
show them, survive a reload, replay in order on reconnect ✓ · camera works through a desk
outage ✓ · outlines for selected + NEXT on Imagery and Streets at 1366 × 768, white neighbours at
zoom 17+ ✓ · BATCH on 230/231 in card + list ✓ · no OrderedBy / Client Ref in the parsed rows ✓ ·
layout audit (no horizontal overflow, nothing ellipsized, ▣ Aerial never overlaps SEQ, card buttons
always visible) at 986 × 695, 1366 × 768, 1920 × 1080 and the 290 px narrowest pane ✓ · mock NMEA moves the dot; bad checksum ignored; GN accepted; V = no fix ✓ · evidence
close ✓ · job identity + proven-job-change wipe ✓ · layouts + panel minimize remembered ✓ ·
inline scripts pass `node --check` ✓.
Route here (10/11, mock, `?route=1`, full Greenville road file, Mock NMEA): no button / no R without
`?route=1` ✓ · Mock NMEA running with no press → no route ✓ · pin click + button and list row + R → route
to that parcel ✓ · wrong turn → "Turn around when safe — then …", 1 reroute, same target ✓ · Route here on
another pin switches the target ✓ · camera shoots the target → route ends, nothing starts after 8 s ✓ ·
a No Photos save on the routed parcel ends it ✓ · No Photos panel: 2.5 + Safety → Driven in card, list and counters, offline too; un-tap → To drive; NVFR with zero photos stays To drive (phone behaviour) ✓ · ■ Stop and Esc ✓ · no road file → "No road file for this county" ✓ ·
banner clear of the address banner, map buttons and panels, address never clipped, no page overflow at
986 × 695, 1366 × 768, 1920 × 1080 (split, log strip, map full) and the 290 px pane ✓. Not tested: the live Firebase link (by instruction), the
real puck, the folder picker on Windows, a true network cut of the service worker (its cache
was checked to hold the shell).

## GO-LIVE (main session, only when Dustin says so)

1. Commit **exactly**: `docs/desk.html`, `docs/desk-sw.js`, `docs/desk/vendor/leaflet.js`,
   `docs/desk/vendor/leaflet.css`, `docs/desk/vendor/xlsx.full.min.js`, `docs/desk/README.md`.
   `docs/desk/mock.js` is optional (harmless: never fetched off localhost).
   **Do not** commit `_desk_mock/`. `docs/desk/route.js` and `docs/desk/route-vendor/` belong to
   the routing build and go live only on their own approval.
2. **No Cloud Functions change. No database-rules change.** All writes are under
   `sessions/<DRIVER>/` with the driver's key (rules: `auth.uid === 'driver_' + $driver`), reads of
   `jobDriven/` are allowed; `driverAuth` is called exactly as index.html calls it.
3. Push; GitHub Pages serves it at **https://lhvconsultingllc.github.io/field-log/desk.html**.
4. Check on Dustin's own key first: open `…/desk.html?key=<DS key>`, load a county, confirm on
   the camera that the job label appears and "Linked" shows, shoot one parcel, watch it go
   Rating… → Driven on the desk.
5. Send Richie `…/desk.html?key=<his key>` with the guide (LHV_Laptop_FieldLog_Guide_Richie.pdf).
6. Rollback: delete the link from his bookmarks; the field-log phone (index.html) is untouched
   and works exactly as before. Kill switch for the desk's service worker:
   `localStorage.desk_sw_off = '1'` in its console, then unregister it in DevTools.
