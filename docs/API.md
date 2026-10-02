# `.mdx` Chart API — for LLMs and scripts

This document is the contract for producing and editing **Quadrant Chart** `.mdx` files
programmatically. It is written to be read by an agent as well as a person.

**Script:** [`Script/mdx_chart.py`](../../../Script/mdx_chart.py) — a dependency-light Python module
and CLI. It is the reference implementation; nothing below requires the Obsidian plugin to be
running, and the plugin is not required to *create* a file, only to render one.

---

## 1. The file format

A `.mdx` file is **plain text**: YAML frontmatter, then free-form body.

```markdown
---
quadrant-chart: 1
title: Q1 Priorities
x:
  label: Impact
  min: 0
  max: 10
y:
  label: Urgency
  min: 0
  max: 10
grid:
  columns: 2
  rows: 2
cells:
  - col: 1
    row: 1
    label: Do now
    color: "#d93025"
    note: Blocking a release
items:
  - id: a1
    text: Rework the sync engine
    x: 8.2
    y: 9
---

Everything below the frontmatter is never touched by the plugin or the script.
```

### Rules that matter

| Rule | Why it matters |
|---|---|
| `quadrant-chart: 1` must be present | This is what claims the file. Without it the plugin ignores it and `mdx_chart.load()` refuses to edit it. |
| Coordinates are **data space**, not pixels | `x`/`y` are positions on the axis range. Resizing a pane or changing `min`/`max` never rewrites them, so a chart authored on a phone lands in the same logical spot on a desktop. |
| `row 0` is the **bottom** band | Rows count along Y from the **minimum**. `row 0` = lowest Y. Getting this backwards silently swaps "helpful"/"harmful" on a SWOT, or "high potential"/"low potential" on a nine-box. This is the single most common error. |
| `col 0` is the **left** band | Columns count along X from the minimum. |
| Body text is preserved byte-for-byte | Only the frontmatter block is rewritten. Notes written under a chart survive every edit. |
| `id` on each item should be stable | Ids identify a label across edits. Use meaningful ones (`s1`, `p21`) so a later run can find and move that exact label. |

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `quadrant-chart` | `1` | **yes** | File marker. |
| `title` | string | no | Drawn above the plot. |
| `x.label` / `y.label` | string | yes (defaults if absent) | Axis captions. |
| `x.min` / `x.max` / `y.min` / `y.max` | number | yes (0/10 default) | Reversed ranges are repaired on open; zero-width is padded. |
| `x.ticks` / `y.ticks` | number[] | no | Omit to derive readable ticks automatically. |
| `grid.columns` / `grid.rows` | int 1–12 | yes (2/2 default) | Any N×M, not just four quadrants. |
| `cells[].col` / `.row` | int | with `cells` | Cell address. Out-of-range entries are **dropped**, not clamped. |
| `cells[].label` | string | no | Cell caption. |
| `cells[].color` | `#rrggbb` | no | Background tint, drawn at 18% opacity. |
| `cells[].note` | string | no | Longer text under the caption. |
| `items[].id` | string | recommended | Stable identity. |
| `items[].text` | string | **yes** | Empty/whitespace-only items are dropped on open. |
| `items[].x` / `.y` | number | **yes** | Data-space position. |
| `items[].color` | `#rrggbb` | no | Label colour; defaults to the theme's text colour. |
| `items[].size` | int | no | Font size in px (8–96). |
| `base-font-size` | int | no | Default label size; omitted when 14. |

---

## 2. Python API

```python
import sys; sys.path.insert(0, "/home/wang/wk/Script")
from mdx_chart import Chart, Axis, load
```

### Create

```python
chart = Chart(
    title="SWOT — Acme",
    x=Axis("Internal  ———  External", -5, 5),
    y=Axis("Harmful  ———  Helpful", -5, 5),
    columns=2,
    rows=2,
)

# Cells. Palette names or hex; names are resolved to hex on write.
chart.add_cell(0, 1, "Strengths",     color="green",  note="Internal · helpful")
chart.add_cell(0, 0, "Weaknesses",    color="red",    note="Internal · harmful")
chart.add_cell(1, 1, "Opportunities", color="blue",   note="External · helpful")
chart.add_cell(1, 0, "Threats",       color="orange", note="External · harmful")

# Labels anywhere on the plot.
chart.add_item("Content-hash sync", x=-3.4, y=4.2, item_id="s1")
chart.add_item("Silent save bug",  x=-4.2, y=-3.2, item_id="w1")

chart.save("SWOT.mdx", body="# Notes\n\nThis body is never rewritten.\n")
```

### Read and update

```python
chart, body = load("SWOT.mdx")

chart.add_item("New risk", x=3.5, y=-2.0, item_id="t1")
chart.set_grid(3, 3)                 # cells outside the new grid are dropped
chart.remove_item("Silent save bug")  # substring match on the text

chart.save("SWOT.mdx", body)         # body must be passed back; it is not re-read
```

### Inspect

```python
print(chart.to_json())           # machine-readable, for an agent
print(chart.counts_by_cell())    # {(col, row): n_items} — layout sanity check
print(chart.quadrant_of(-3.4, 4.2))   # (0, 1)
```

### API surface

| Call | Purpose |
|---|---|
| `Chart(title, x, y, columns, rows, cells, items, base_font_size)` | Construct. |
| `Chart.blank(columns=2, rows=2, title=None)` | Defaults, nothing else. |
| `Axis(label, minimum, maximum, ticks=None)` | One axis. |
| `chart.add_cell(col, row, label=None, color=None, note=None)` | Create/replace a cell. **Raises** if the address is outside the grid. |
| `chart.add_item(text, x, y, color=None, size=None, item_id=None)` | Add a label. Out-of-range coords are clamped with a warning on stderr. **Raises** on empty text or duplicate `item_id`. |
| `chart.remove_item(needle)` | Delete by substring. Returns `bool`. |
| `chart.set_grid(columns, rows)` | Resize; drops cells that fall outside. |
| `chart.quadrant_of(x, y)` | Which cell contains a point. |
| `chart.counts_by_cell()` | Items per cell. |
| `chart.to_json()` / `chart.to_frontmatter()` | Serialise. |
| `chart.save(path, body="")` | Write, replacing only the frontmatter. |
| `load(path)` | Read. Returns `(chart, body)`. **Raises** if not a chart. |
| `PALETTE` | `{"red": "#d93025", …}` — 9 named colours. |

**Palette:** red `#d93025` · orange `#f9ab00` · yellow `#fdd663` · green `#188038` ·
teal `#12b5cb` · blue `#1a73e8` · purple `#9334e6` · pink `#e374b9` · grey `#9aa0a6`

When choosing colours for adjacent cells, pick **different hues**, not different brightnesses of one
hue — cell fills render at 18% opacity, and light/dark variants of a single colour blend to nearly
the same tint, which defeats the point of colouring them at all.

---

## 3. CLI

Same operations without writing Python.

```bash
# Create
python3 Script/mdx_chart.py create --path Q1.mdx --title "Q1 Priorities" \
    --x-label "Impact" --x-min 0 --x-max 10 \
    --y-label "Urgency" --y-min 0 --y-max 10 \
    --columns 2 --rows 2 --body "# Notes"

# Add a label
python3 Script/mdx_chart.py add-item --path Q1.mdx --text "Rework sync engine" --x 8.2 --y 9

# Name and colour a cell
python3 Script/mdx_chart.py set-cell --path Q1.mdx --col 1 --row 1 --label "Do now" --color red
python3 Script/mdx_chart.py set-cell --path Q1.mdx --col 0 --row 0 --clear

# Remove, inspect
python3 Script/mdx_chart.py remove-item --path Q1.mdx --text "Rework"
python3 Script/mdx_chart.py show      --path Q1.mdx          # JSON to stdout
```

`create` refuses to overwrite an existing file unless `--force` is given.

---

## 4. Recipes

### Talent nine-box (人才九宫格)

X = performance (col 0 low → 2 high), Y = potential (row 0 **low/bottom** → 2 high).

| | col 0 低绩效 | col 1 中绩效 | col 2 高绩效 |
|---|---|---|---|
| **row 2 高潜力** | 待观察 Watch | 高潜者 High potential | 明星 Star |
| **row 1 中潜力** | 待改进 Needs work | 中坚力量 Core player | 绩优者 High performer |
| **row 0 低潜力** | 需优化 Review | 合格者 Meets the bar | 专业人士 Specialist |

```python
c = Chart(title="人才九宫格", x=Axis("绩效 low → high", 0, 3), y=Axis("潜力 low → high", 0, 3),
          columns=3, rows=3)
for col, row, label, colour in [
    (2, 2, "明星 Star", "purple"),      (2, 1, "绩优者 High performer", "blue"),
    (2, 0, "专业人士 Specialist", "teal"),(1, 2, "高潜者 High potential", "green"),
    (1, 1, "中坚力量 Core player", "yellow"), (1, 0, "合格者 Meets the bar", "orange"),
    (0, 2, "待观察 Watch", "pink"),    (0, 1, "待改进 Needs work", "red"),
    (0, 0, "需优化 Review", "grey"),
]:
    c.add_cell(col, row, label, color=colour)

# One person per box: put them at the cell's centre (col + 0.5, row + 0.5).
for col, row, name in [(2, 2, "A. Chen"), (1, 1, "E. Sun"), (0, 0, "I. Ma")]:
    c.add_item(name, x=col + 0.5, y=row + 0.5, item_id=f"p{col}{row}")
```

A worked example: `/home/wang/wk/wk/人才九宫格-示例.mdx`.

### SWOT

| | col 0 Internal | col 1 External |
|---|---|---|
| **row 1 Helpful** | Strengths (green) | Opportunities (blue) |
| **row 0 Harmful** | Weaknesses (red) | Threats (orange) |

```python
c = Chart(title="SWOT", x=Axis("Internal — External", -5, 5), y=Axis("Harmful — Helpful", -5, 5),
          columns=2, rows=2)
c.add_cell(0, 1, "Strengths", color="green");  c.add_cell(1, 1, "Opportunities", color="blue")
c.add_cell(0, 0, "Weaknesses", color="red");   c.add_cell(1, 0, "Threats", color="orange")
# Strengths and Weaknesses are INTERNAL  -> negative x
# Opportunities and Threats are EXTERNAL -> positive x
# Opportunities and Strengths are HELPFUL -> positive y
# Threats and Weaknesses are HARMFUL    -> negative y
```

A worked example: `/home/wang/wk/wk/SWOT-插件价值.mdx`.

### Any other N×M

Set `columns`/`rows` to anything from 1 to 12 and address cells by `(col, row)`. Split positions are
derived by dividing the range evenly, so no extra numbers are stored.

---

## 5. Other ways to edit the same files

The format is plain YAML, so the script is one option among several.

| Approach | Good for |
|---|---|
| **`Script/mdx_chart.py`** | Batch generation, an agent, cron, CI. Safest — validates before writing. |
| **Any YAML library** | Custom tooling. Replace the frontmatter block; keep the body. |
| **Obsidian plugin API** | Another plugin: `app.vault.process(file, fn)` (atomic read-modify-write). Do **not** use `fileManager.processFrontMatter` — on a `.mdx` file it is a no-op that resolves successfully and writes nothing. |
| **BRAT / manual install** | Only for installing the *renderer*; it cannot create charts. |

> **Do not use `processFrontMatter` for `.mdx`.** Measured on a live vault: it returns OK and the
> file stays byte-identical. That failure is silent, which is exactly why it cost several rounds to
> track down. `vault.process` has no such problem.

---

## 6. Checklist before writing a chart

1. `quadrant-chart: 1` present.
2. Cell addresses match the grid — and **`row 0` is the bottom**.
3. Every label's coordinates put it in the box you intend.
4. Colours are distinct **hues**, not brightnesses of one hue.
5. Item ids are stable if the chart will be updated later.
6. Anything personal or sensitive in a chart is fictional sample data, or the file is not shared.
7. After writing, re-read with `load()` and confirm `counts_by_cell()` matches the intent.

`tests/demoCharts.test.ts` in the plugin repo implements exactly this checklist against the two
worked examples, and it caught three real placement errors while they were being written.
