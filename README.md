# Quadrant Chart

Draw labelled quadrant charts in Obsidian, with free-floating text placed anywhere on the plot.
Charts live in `.mdx` files as plain YAML frontmatter, so they stay readable, hand-editable, and
diff-friendly.

## What it does

- **Any N × M grid**, not just four quadrants. Set columns and rows independently, from 1×1 to 8×8.
- **Labelled axes** — name the X and Y axes, set their ranges, and the tick values are derived.
  Explicit ticks are supported when you want them.
- **Free text anywhere** — labels are not tied to quadrants. Drop one at any coordinate, drag it to
  reposition, double-click to edit, right-click to delete.
- **Cell labels, notes and colours** — name each cell, add longer text underneath, and tint it.
- **Styled labels** — give a label its own background plate, an outline, and its own text size, so
  it stays readable wherever it lands.
- **Overlapping labels are reachable** — click the same spot again to step down through the stack, or
  use *Bring to front* / *Send to back*.
- **Undo** — <kbd>Ctrl</kbd>+<kbd>Z</kbd> steps back any change, including an accidental drag.
- **Export** — save the chart as a JPG or PNG next to the `.mdx` file.
- **Built-in examples** — a SWOT and a talent nine-box, creatable from the command palette.
- **Your notes stay yours** — the chart is the YAML frontmatter; everything below it is free text the
  plugin never touches.
- **Scriptable** — a chart is plain YAML, so anything that can write YAML can create one.

## Using it

**Create a chart** — command palette → *Create quadrant chart*. Pick a name and it opens straight
into the editor.

**Start from an example** — command palette → *Create quadrant chart from example* → SWOT or talent
nine-box. You get the cells, colours, labels and an explanatory body to edit.

**Add text** — double-click anywhere on the plot, or use the *Add label* button. With nothing
pointed at, a new label lands in the middle of the cell you last clicked.

**Move text** — drag it.

**Edit text** — double-click it, or select it and use the *Label* button → *Edit text…*. Clearing
the text deletes the label.

**Delete text** — right-click it, or select it and use the *Label* button → *Delete label*.

**Select a label or a cell** — click it. A click on a label selects the label, never the cell
underneath; a click on empty space selects the cell. Both draw a dashed box.

**Style a label** — select it, then *Label* → background colour, *Draw a box around it*, or a text
size. *Default* clears the size override so the label follows the chart again.

**Reach a label under another** — click the same spot repeatedly to step down the stack, or use *Send
to back* / *Bring to front*. Order is stored in the file, so it survives a reload.

**Name a cell** — click the cell, then the **Cell** button.

**Change the grid** — the **Grid N×M** button. Columns and rows are independent, and the button
always shows the current size. You can also drag a dashed split line on the canvas.

**Name the axes / set the range** — **Axes** button, or click the X or Y caption on the canvas.

**Export an image** — the **Export** button, or the command palette → *Export chart as image*. Choose
JPG or PNG; the file is written beside the `.mdx` and never overwrites an existing one.

Everything you do is written straight to the file, so you can also just edit the YAML.

## Keyboard

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> | Undo the last change to this chart |

Redo is not offered — undo steps back one change at a time.

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
    background: "#fdd663"   # optional plate behind the text
    box: true                # optional outline around it
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
npm test          # 328 tests: format, geometry, hit-testing, undo, image export, the
                  # save path, and interoperability with Script/mdx_chart.py
```

To build straight into a vault's plugin folder:

```bash
OUTDIR=~/vault/.obsidian/plugins/quadrant-chart npm run build
```
