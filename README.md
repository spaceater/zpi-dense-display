# @semanaut/zpi-dense-display

Dense display for [pi](https://github.com/earendil-works/pi) — tighten the TUI's vertical space. Rendering only; the session transcript and model context keep the original content.

- Markdown post-render filtering: drops blank rendered lines and ``` fence borders
- Finished tool calls collapse to one clickable line (click / Ctrl+O to expand)
- Thinking runs collapse to a single line — governed by pi's own `hideThinkingBlock` setting: when `hideThinkingBlock` is `false`, the thinking run shows as one collapsed line; when `true`, the thinking block is not shown at all

## Install

```bash
pi install npm:@semanaut/zpi-dense-display
```

## Versioning

The extension's version always matches the pi version it is built for: `1.1.0` of this package targets pi `1.1.0`, `1.2.0` targets pi `1.2.0`, and so on — install the version that matches your pi. If a release has to be repeated while the target pi version is unchanged, it gets a prerelease suffix instead: `1.1.0-2`, then `-3`, and so on. npm never allows overwriting an already-published version: every publish is a new, immutable version.
