# Changelog

## 0.5.3
- Screenshots in the Marketplace listing; repository and issue links

## 0.5.2
- Opt-in: .ini files open as text by default. "INI: Always Open .ini Files as Tables" makes the table view the default (offered once, the first time you open a table)

## 0.5.1
- Large sections render the first 1,500 rows (200 in form view) with a "Show all" button; filters still search every row
- Minimum VS Code version raised to 1.86 (needed for theme-aware colours)

## 0.5.0
- New rows are compared against the baseline's default row of the same table (e.g. IPGroup 0 "Default_IPG"), so only non-default cells are highlighted
- `iniTableView.diffIgnore`: skip deployment-specific sections or items (defaults: InterfaceTable, StaticRouteTable, DeviceTable, PhysicalPortsTable, EtherGroupTable, SYSTEM Params/HALocalMAC)

## 0.4.0
- Compare with baseline: pick a default / golden INI and see changed cells (amber, hover for the baseline value), added rows (green) and removed rows (red, struck through). "Changes only" hides unchanged sections, rows and columns. Per-file, or for all INIs via `iniTableView.defaultBaseline`
- Non-key sections styled consistently in grey; table borders visible in every theme
- Key/value sections no longer stretch to full width
- Quoted lists (e.g. ActivityListToLog) are no longer mangled

## 0.3.0
- Columns size to their content; drag a header edge to resize, double-click it to auto-fit (widths remembered per section)
- Per-section filter with column picker: substring (`teams`), wildcards (`teams-oc*`, `*8091*`, `?`), exact (`"OC-Anchor"`); Esc clears
- Global value search also supports wildcards and "exact"

## 0.2.0
- Key sections highlighted and colour-grouped (Routing, Manipulation, Network, Media & Coders, Security & Mgmt), configurable via `iniTableView.keySections`
- Tab panel: filter box, sort (Key first / A–Z / File order), "★ only" toggle
- Narrow tables stretch to full width and wrap long values; "Wrap text" toggle for wide tables

## 0.1.0
- Initial release: table and form views, section tabs (top or right), value search, jump to line
