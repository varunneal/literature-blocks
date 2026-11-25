# Literature Blocks

An Obsidian plugin that renders `paper` codeblocks as cards for tracking academic papers and research.

## `paper` blocks

**Usage:**

Use the command palette (`Cmd+P`) → "Insert paper" to insert a template, or manually create:

```
```paper
title: Attention Is All You Need
authors: Vaswani et al.
date: 2017
link: https://arxiv.org/abs/1706.03762
```
```

**Renders as:**

A styled card with:
- Bold title
- Authors and date in muted text
- PDF icon linking to the paper (top right)
- Click anywhere on the card to edit

**Outline:**

Each card is listed in Obsidian's core Outline view by its title and date, nested under the heading it sits below. Selecting it scrolls to the card. The card button at the top of the Outline view shows or hides these entries. This hooks into internals of the core Outline view, so it may stop working after an Obsidian update; the outline then falls back to headings only.

## Installation

```bash
cd your-vault/.obsidian/plugins/
bun create varunneal/literature-blocks
cd literature-blocks
bun run build
```

Then reload Obsidian and enable the plugin in Settings → Community plugins.

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Create a folder called `literature-blocks` in your vault's `.obsidian/plugins/` directory
3. Copy the downloaded files into that folder
4. Reload Obsidian and enable the plugin

## Development

```bash
# Install dependencies
bun install

# Build (one-time)
bun run build

# Watch mode (auto-rebuild on changes)
bun run dev
```

## License

0-BSD
