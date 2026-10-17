/**
 * zpi-dense-display — tighten the TUI's vertical space. Rendering only: the
 * transcript and the model context always keep the original content.
 *
 * A. Markdown: drop blank rendered lines and ``` fence borders.
 * B. Tool rows: finished calls collapse to one clickable line —
 *    `toolName 12s arg key=n outcome`; multi-line args and error outcomes keep
 *    every line, compressed onto the row with alternating segment backgrounds;
 *    numeric args always shown as key=value. Thinking runs collapse to one
 *    line (or nothing when "hideThinkingBlock" is true). Padded blank rows
 *    between messages/turns are removed; expanded/streaming rows keep a
 *    slightly lighter background.
 * C. Spacer-only containers above the editor render as nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, MouseRegion, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as os from "node:os";

type ThemeLike = {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	getBgAnsi(color: string): string;
};

// pi re-evaluates this file on /reload; share state on globalThis so earlier
// loads keep working (ctx.ui.theme is a live proxy, so theme changes follow).
const state: { theme?: ThemeLike } =
	((globalThis as any)[Symbol.for("zpi-dense-display")] ??= { theme: undefined });

// Remember pi's own method per prototype so re-loading swaps the wrapper
// instead of stacking another one on top.
function hook(proto: any, method: string, wrap: (orig: any) => any): void {
	const original = (proto.__denseOriginal ??= {});
	const base = original[method] ?? proto[method];
	if (typeof base !== "function") return;
	original[method] = base;
	proto[method] = wrap(base);
}

const lineComponent = (render: (width: number) => string[]) => ({ render, invalidate() {} });

// truncateToWidth emits a reset before its ellipsis, dropping the active
// background styling: strip it and append the caller's ellipsis.
function truncateStyled(text: string, avail: number, ellipsis: string): string {
	if (visibleWidth(text) <= avail) return text;
	const head = avail > 1 ? truncateToWidth(text, avail - 1, "").replace(/\x1b\[0m$/, "") : "";
	return head + ellipsis;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// A. Markdown
// ---------------------------------------------------------------------------

// Border lines sit at the component's base padding while code content lines
// sit two spaces deeper, so a literal ``` inside code content is never
// mistaken for a border.
function compactLines(lines: string[]): string[] {
	const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	const indentAt = (i: number) => plain[i].length - plain[i].trimStart().length;
	let base = Infinity;
	for (let i = 0; i < plain.length; i++) if (plain[i].trim()) base = Math.min(base, indentAt(i));
	return lines.filter((_, i) => plain[i].trim() && !(indentAt(i) === base && plain[i].startsWith("```", base)));
}

// ---------------------------------------------------------------------------
// B1. Tool rows
// ---------------------------------------------------------------------------

// Mirror pi's renderToolPath → shortenPath2: home prefix collapses to "~".
const shortenPath = (p: string): string => {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

const isPathKey = (k: string): boolean => k === "path" || k === "filePath";

// String arg to preview, as its kept lines. The priority chain skips
// null/undefined/blank values; the insertion-order fallback covers unknown
// schemas (codemode, MCP tools, …), where a home-prefixed string is almost
// certainly a path and gets shortened like pi's own labels.
const primaryString = (args: any): string[] => {
	const usable = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
	const hit = [
		["command", args?.command], ["path", args?.path], ["pattern", args?.pattern],
		["query", args?.query], ["filePath", args?.filePath],
	].find(([, v]) => usable(v));
	const value = hit
		? (isPathKey(hit[0] as string) ? shortenPath(hit[1] as string) : hit[1] as string)
		: shortenPath(Object.values(args ?? {}).find(usable) ?? "");
	return keptLines(value);
};

// Numeric args ignore the chain and are always shown (read's offset/limit,
// grep/ls/find's limit, …).
const numericArgs = (args: any): string =>
	Object.entries(args ?? {})
		.filter(([, v]) => typeof v === "number")
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");

const textOutput = (result: any) => result.content.find((c: any) => c.type === "text")?.text ?? "";

const hasImages = (result: any) => result.content.some((c: any) => c.type === "image");

const diffStats = (diff: string) => {
	const lines = diff.split("\n");
	return {
		add: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
		rem: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
	};
};

const BG_LIGHTEN = 0.06;
const BG_DARKEN = 0.2;

function mixBgAnsi(code: string, mix: (v: number) => number): string | undefined {
	const m = code.match(/^\x1b\[48;2;(\d+);(\d+);(\d+)m$/);
	if (!m) return undefined;
	return `\x1b[48;2;${mix(Number(m[1]))};${mix(Number(m[2]))};${mix(Number(m[3]))}m`;
}

const lightenBgAnsi = (code: string) => mixBgAnsi(code, (v) => Math.round(v + (255 - v) * BG_LIGHTEN));
const darkenBgAnsi = (code: string) => mixBgAnsi(code, (v) => Math.round(v * (1 - BG_DARKEN)));

// Rewriting the theme's own bg codes means a second pass finds nothing to
// replace, so expanded/streaming rows stay lightened after /reload.
function lightenToolBg(lines: string[], theme: ThemeLike): string[] {
	for (const token of ["toolSuccessBg", "toolErrorBg"]) {
		const from = theme.getBgAnsi(token);
		const to = lightenBgAnsi(from);
		if (!to) continue;
		lines = lines.map((l) => (l.includes(from) ? l.split(from).join(to) : l));
	}
	return lines;
}

// Multi-line content on one row: the background alternates between the row's
// tool background and its darkened variant, marking the original line breaks
// without inserting any character. The separating space is emitted inside the
// FOLLOWING segment, so the background switch happens one cell early, at the
// space. Safe to compose because theme.fg resets only the foreground (ESC[39m)
// and theme.bg only the background (ESC[49m); non-truecolor themes cannot mix
// and fall back to foreground alternation.
function compressLines(lines: string[], theme: ThemeLike, bgToken: string, fgToken = "accent"): string {
	const rowBg = theme.getBgAnsi(bgToken);
	const darker = darkenBgAnsi(rowBg);
	if (!darker) {
		return lines.map((l, i) => theme.fg(i % 2 ? "dim" : fgToken, i > 0 ? ` ${l}` : l)).join("");
	}
	return lines
		.map((l, i) => `${i % 2 ? darker : rowBg}${theme.fg(fgToken, i > 0 ? ` ${l}` : l)}`)
		.join("");
}

const keptLines = (text: string): string[] => text.split("\n").map(oneLine).filter((l) => l !== "");

function buildLine(comp: any, theme: ThemeLike): { bg: string; text: string } {
	const { result } = comp;
	const failed = result.isError === true;
	const bg = failed ? "toolErrorBg" : "toolSuccessBg";
	let text = theme.fg("toolTitle", theme.bold(comp.toolName));
	if (result.durationMs >= 5000) {
		text += theme.fg(failed ? "error" : "success", ` ${Math.round(result.durationMs / 1000)}s`);
	}
	const argLines = primaryString(comp.args);
	if (argLines.length === 1) {
		text += theme.fg("accent", ` ${argLines[0]}`);
	} else if (argLines.length > 1) {
		// Trailing row-bg code returns the following segments to the row's own
		// background after the alternating ones.
		text += ` ${compressLines(argLines, theme, bg)}${theme.getBgAnsi(bg)}`;
	}
	const nums = numericArgs(comp.args);
	if (nums) text += theme.fg("warning", ` ${nums}`);

	if (failed) {
		const outcomeLines = keptLines(textOutput(result));
		if (outcomeLines.length <= 1) {
			return { bg, text: text + theme.fg("toolOutput", ` ${outcomeLines[0] ?? "error"}`) };
		}
		// Trailing row-bg code hands the row's background back to the Box's padding.
		return {
			bg,
			text: text + " " + compressLines(outcomeLines, theme, bg, "toolOutput") + theme.getBgAnsi(bg),
		};
	}
	if (typeof result.details?.diff === "string") {
		const { add, rem } = diffStats(result.details.diff);
		text += theme.fg("success", ` +${add}`) + theme.fg("error", ` -${rem}`);
	}
	if (result.details?.truncation?.truncated) text += theme.fg("warning", " [trunc]");
	return { bg, text };
}

// Self-rendered tool blocks (renderShell "self", e.g. edit) wrap their content
// in pi's own MouseRegion + Box: strip their Spacers and vertical padding too.
function densifySelfRender(node: any): void {
	const kids = node.children;
	if (!kids) return;
	for (let i = kids.length - 1; i >= 0; i--) {
		if (kids[i] instanceof Spacer) { kids.splice(i, 1); continue; }
		const inner = kids[i] instanceof MouseRegion ? kids[i].child : kids[i];
		if (inner instanceof Box) inner.paddingY = 0;
		densifySelfRender(inner);
	}
}

function patchToolExecutionComponent() {
	const proto = ToolExecutionComponent.prototype as any;

	hook(proto, "render", (origRender) => function (this: any, width: number): string[] {
		if (this.hideComponent) return [];
		if (this.__denseDisplayOneLine) return this.contentBox.render(width);
		const lines = origRender.call(this, width);
		// Self-shell render() prepends a hard blank line; pi's y-1 mouse offset
		// inside handleMouse stays valid after stripping it.
		if (this.getRenderShell() === "self" && lines[0] === "") lines.shift();
		return state.theme ? lightenToolBg(lines, state.theme) : lines;
	});

	hook(proto, "handleMouse", (origHandleMouse) => function (this: any, event: any) {
		if (this.__denseDisplayOneLine) return this.contentBox.handleMouse(event);
		return origHandleMouse.call(this, event);
	});

	hook(proto, "updateDisplay", (origUpdateDisplay) => function (this: any) {
		this.__denseDisplayOneLine = false;
		this.contentBox.paddingY = 0;
		this.contentText.paddingY = 0;
		if (this.children[0] instanceof Spacer) this.children.splice(0, 1);

		// Only a finished result collapses.
		const theme = state.theme;
		if (!theme || !this.result || this.isPartial || this.expanded || hasImages(this.result)) {
			origUpdateDisplay.call(this);
			if (this.getRenderShell() === "self") densifySelfRender(this.selfRenderContainer);
			return;
		}

		const built = buildLine(this, theme);
		const box = this.contentBox;
		box.clear();
		this.hideComponent = false;
		// pi applies outputPad only to the default-shell container; without this
		// self-shell (edit) and renderer-less tools collapse at the Box default.
		box.setPaddingX(this.outputPad);
		box.setBgFn((text: string) => theme.bg(built.bg, text));
		box.addChild(new MouseRegion(
			lineComponent((width) => [truncateStyled(built.text, Math.max(0, width), theme.fg("dim", "…"))]),
			(event) => {
				if (!this.result || event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(true);
				return { handled: true };
			},
		));
		this.__denseDisplayOneLine = true;
	});
}

// ---------------------------------------------------------------------------
// B2. Thinking rows
// ---------------------------------------------------------------------------

function lastThinkingLine(content: any): string | undefined {
	const blocks = content.filter((c: any) => c.type === "thinking" && c.thinking.trim());
	const text: string = blocks[blocks.length - 1]?.thinking.trim() ?? "";
	return oneLine(text.slice(text.lastIndexOf("\n") + 1)) || undefined;
}

// pi collapses a thinking run when `overrides.get(run) ?? hideThinkingBlock`
// is truthy. A Map reporting unknown runs as hidden collapses every run
// without touching the user's setting; a click records an explicit false, and
// pi's setHideThinkingBlock clears the overrides.
class ThinkingCollapsed extends Map<number, boolean> {
	get(run: number): boolean {
		return super.has(run) ? !!super.get(run) : true;
	}
}

function patchAssistantMessageComponent() {
	hook(AssistantMessageComponent.prototype as any, "updateContent", (origUpdateContent) =>
		function (this: any, message: any, isStreaming?: boolean) {
			if (!(this.thinkingVisibilityOverrides instanceof ThinkingCollapsed))
				this.thinkingVisibilityOverrides = new ThinkingCollapsed();
			const preview = lastThinkingLine(message.content);
			if (preview) this.hiddenThinkingLabel = preview;

			origUpdateContent.call(this, message, isStreaming);

			const hide = this.hideThinkingBlock === true;
			const theme = state.theme;
			const label = this.hiddenThinkingLabel;
			const pad = this.outputPad;
			// pi's label component would wrap; render the live line truncated.
			const row = theme && label
				? lineComponent((width) =>
					[" ".repeat(pad) + theme.italic(theme.fg("thinkingText", truncateStyled(label, Math.max(0, width - pad), "…")))])
				: undefined;

			const kids = this.contentContainer.children;
			for (let i = kids.length - 1; i >= 0; i--) {
				if (kids[i] instanceof Spacer) { kids.splice(i, 1); continue; }
				if (!(kids[i] instanceof MouseRegion)) continue;
				if (hide) kids.splice(i, 1);
				else if (row && kids[i].child instanceof Text) kids[i].child = row;
			}
		});
}

// ---------------------------------------------------------------------------
// B3. Turn-end spacers
// ---------------------------------------------------------------------------

// pi pads every turn with a Spacer before each user message; dropping it at
// insert time makes turns end flush.
function patchTurnEndSpacer() {
	hook(Container.prototype as any, "addChild", (origAddChild) => function (this: any, child: any) {
		const kids = this.children;
		if (child instanceof UserMessageComponent) {
			while (kids.length && kids[kids.length - 1] instanceof Spacer) kids.pop();
		}
		origAddChild.call(this, child);
	});
}

// ---------------------------------------------------------------------------
// C. Blank line above the editor
// ---------------------------------------------------------------------------

// The widget container above the editor carries a Spacer even when empty. A
// container whose children are all Spacers has no visible content, so such
// containers render as nothing; containers with real content keep their
// leading spacers.
function patchSpacerOnlyContainers() {
	hook(Container.prototype as any, "render", (origRender) => function (this: any, width: number): string[] {
		const kids = this.children;
		if (kids?.length && kids.every((k: any) => k instanceof Spacer)) return [];
		return origRender.call(this, width);
	});
}

export default function zpiDenseDisplayExtension(pi: ExtensionAPI) {
	hook(Markdown.prototype as any, "render", (origRender: any) => function (this: any, width: number) {
		return compactLines(origRender.call(this, width));
	});
	patchToolExecutionComponent();
	patchAssistantMessageComponent();
	patchTurnEndSpacer();
	patchSpacerOnlyContainers();

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		state.theme = (ctx.ui as any).theme;
	});
}
