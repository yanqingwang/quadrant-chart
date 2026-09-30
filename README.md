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

**Change the grid** — *Grid* button → pick a size. Drag a dashed split line to change it directly.

**Name a cell** — *Cell* button, or edit the frontmatter by hand.

**Name the axes / set the range** — *Axes* button.

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

## Note on the extension

`.mdx` is also React's component-file suffix. There is no conflict inside Obsidian, which has no MDX
pipeline of its own, but be aware of it if a vault ever gains a real MDX toolchain.

## Building

```bash
npm install
npm run build     # typecheck + production bundle -> main.js
npm test          # 46 unit tests over the format and the geometry
```

To build straight into a vault's plugin folder:

```bash
OUTDIR=~/vault/.obsidian/plugins/quadrant-chart npm run build
```
