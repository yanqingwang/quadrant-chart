# Quadrant Chart

Draw labelled quadrant charts in Obsidian, with free-floating text placed anywhere on the plot.
Charts live in `.mdx` files as plain YAML frontmatter, so they stay readable, hand-editable, and
diff-friendly.

## What it does

- **Any N × M grid**, not just four quadrants. Set columns and rows independently.
- **Labelled axes** — name the X and Y axes, set their ranges, and the tick values are derived.
  Explicit ticks are supported when you want them.
- **Free text anywhere** — labels are not tied to quadrants. Drop one at any coordinate, drag it to
  reposition, double-click to edit, right-click to delete.
- **Cell labels and notes** — name each cell and give it a background tint, with optional longer
  text underneath.
- **Your notes stay yours** — the chart is the YAML frontmatter; everything below it is free text the
  plugin never touches.

## Using it

**Create a chart** — command palette → *Create quadrant chart*. Pick a name and it opens straight
into the editor.

**Add text** — double-click anywhere on the plot, or use the *Add label* button.

**Move text** — drag it.

**Edit text** — double-click it. Clearing the text deletes the label.

**Delete text** — right-click it.

**Change the grid** — the **Grid N×M** button in the toolbar. It opens a menu with three sections:

- **Columns (split the horizontal axis)** — 1 to 8
- **Rows (split the vertical axis)** — 1 to 8
- **Presets** — 2 × 2, 3 × 3, 4 × 4

Columns and rows are set independently, so any N × M from 1×1 to 8×8 is reachable; the button always
shows the current size. You can also drag a dashed split line on the canvas to resize.

**Name a cell** — the **Cell** button names the cell in the middle of the plot. To name a different
one, resize the grid so that cell is the middle one, or edit the `cells:` list in the frontmatter
directly, where each entry is `{col, row}` counted from the low end of each axis.

**Name the axes / set the range** — **Axes** button, or just click the X or Y caption on the canvas.

Everything you do is written straight to the file, so you can also just edit the YAML.

## The `.mdx` format

A chart is a YAML frontmatter block. The body after it is yours and is never modified.

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
    note: Anything blocking a release
items:
  - id: a1
    text: Rework the sync engine
    x: 8.2
    y: 9
---

Notes go here. The plugin never rewrites anything below the frontmatter.
```

Coordinates are stored in **data space** — the axis `min`/`max` range — not in pixels. Resizing the
pane or changing the range never rewrites your numbers, which is what lets a chart saved on a phone
land in the same logical spot on a desktop.

`quadrant-chart: 1` is what marks the file as a chart. Without it, a `.mdx` file is left alone.

A damaged file still opens: missing fields fall back to defaults, a reversed axis range is repaired,
and out-of-range cells are dropped. The point is that you can always see the file to fix it.

One trap worth writing down, because it is not visible from the format:

> **`row 0` is the bottom band.** Rows are counted along Y from the *minimum*, and columns along X
> from the minimum. Get it backwards and a SWOT silently swaps "helpful" with "harmful" — the chart
> still renders, it is just wrong. The same applies to a nine-box, where it inverts high and low
> potential.

## Generating charts programmatically

Because a chart is plain YAML, **you do not need the plugin to create one.** Anything that can write
YAML can produce a chart; the plugin only has to render it. That includes an LLM, a cron job, a
spreadsheet export, or another plugin.

A reference implementation ships with this workspace:

```bash
python3 /home/wang/wk/Script/mdx_chart.py --help
```

```python
import sys; sys.path.insert(0, "/home/wang/wk/Script")
from mdx_chart import Chart, Axis

chart = Chart(
    title="SWOT",
    x=Axis("Internal  ———  External", -5, 5),
    y=Axis("Harmful  ———  Helpful", -5, 5),
    columns=2, rows=2,
)
chart.add_cell(0, 1, "Strengths",     color="green",  note="Internal · helpful")
chart.add_cell(0, 0, "Weaknesses",    color="red",    note="Internal · harmful")
chart.add_cell(1, 1, "Opportunities", color="blue",   note="External · helpful")
chart.add_cell(1, 0, "Threats",       color="orange", note="External · harmful")
chart.add_item("Plain-text format — git-diffable", x=-3.4, y=4.2, item_id="s1")
chart.save("SWOT.mdx", body="# Notes\n\nThis body is never rewritten.\n")
```

The same operations from the command line:

```bash
python3 Script/mdx_chart.py create   --path Q1.mdx --title "Q1 Priorities" --columns 2 --rows 2
python3 Script/mdx_chart.py set-cell --path Q1.mdx --col 1 --row 1 --label "Do now" --color red
python3 Script/mdx_chart.py add-item --path Q1.mdx --text "Rework sync engine" --x 8.2 --y 9
python3 Script/mdx_chart.py show     --path Q1.mdx        # JSON, for an agent to read
```

It edits in place: `load()` returns the chart *and* the body, and `save()` rewrites only the
frontmatter, so notes written under a chart survive. It refuses to overwrite on `create` without
`--force`, and refuses to touch a file that is not a chart at all.

**Full reference — [`docs/API.md`](docs/API.md).** It is written to be read by an agent: the field
table, the complete API surface, the CLI, worked recipes for SWOT and the talent nine-box, the
colour palette, a pre-write checklist, and the `processFrontMatter` warning below.

Worked examples, both generated through that API:

- `/home/wang/wk/wk/SWOT-插件价值.mdx`
- `/home/wang/wk/wk/人才九宫格-示例.mdx`

### If you write a plugin that edits `.mdx`

Use `app.vault.process(file, fn)` for the atomic read-modify-write.

> **Do not use `fileManager.processFrontMatter` on a `.mdx` file.** Measured on a live vault, it
> resolves successfully and writes nothing — the file stays byte-identical. It is a *silent* no-op,
> which is why it cost several rounds to track down. Its callback also takes `(frontmatter) => void`,
> so a returned object is discarded.

## Note on the extension

`.mdx` is also React's component-file suffix. There is no conflict inside Obsidian, which has no MDX
pipeline of its own, but be aware of it if a vault ever gains a real MDX toolchain.

## Building

```bash
npm install
npm run build     # typecheck + production bundle -> main.js
npm test          # 155 tests: format, geometry, canvas hit-testing, save paths, and
                  # interoperability with Script/mdx_chart.py
```

To build straight into a vault's plugin folder:

```bash
OUTDIR=~/vault/.obsidian/plugins/quadrant-chart npm run build
```
