# @semanaut/zpi-dense-display

Dense display for [pi](https://github.com/earendil-works/pi) — tighten the TUI's vertical space. Rendering only; the session transcript and model context keep the original content.

Developed against pi 1.1.0; see the `piVersion` field in `package.json`.

- Markdown post-render filtering: drops blank rendered lines and ``` fence borders
- Finished tool calls collapse to one clickable line (click / Ctrl+O to expand)
- Thinking runs collapse to a single line — governed by pi's own `hideThinkingBlock` setting: when `hideThinkingBlock` is `false`, the thinking run shows as one collapsed line; when `true`, the thinking block is not shown at all

## Install

```bash
pi install npm:@semanaut/zpi-dense-display
```
