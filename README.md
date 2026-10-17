# @semanaut/zpi-dense-display

Dense display for [pi](https://github.com/earendil-works/pi) — tighten the TUI's vertical space. Rendering only; the session transcript and model context keep the original content.

- Markdown post-render filtering: drops blank rendered lines and ``` fence borders
- Finished tool calls collapse to one clickable line (click / Ctrl+O to expand)
  - `toolName 12s arg key=n outcome` — elapsed time past 5s, tinted by outcome; numeric args (read's offset/limit, grep's limit, …) always shown as `key=value`
  - path args are shortened the way pi's own labels do (home prefix → `~`)
  - multi-line args (a multi-line command, pasted code) keep every line, compressed onto the row: line breaks are marked by alternating segment backgrounds — the row's tool background and its darkened variant — with the separating space belonging to the following segment, so the switch lands one cell early; no characters are inserted and the text stays copy-pasteable
  - failed calls append the error output compressed the same way; "hideThinkingBlock"-style truncation flags (`[trunc]`) and diff sizes (`+N -M`) are kept as compact flags
- Thinking runs collapse to a single line — governed by pi's own `hideThinkingBlock` setting: when `hideThinkingBlock` is `false`, the thinking run shows as one collapsed line; when `true`, the thinking block is not shown at all
- The fixed blank line pi keeps above the input box (the empty widget container's spacer) is removed — a container holding nothing but spacers renders as nothing

## Install

```bash
pi install npm:@semanaut/zpi-dense-display
```
