/**
 * zpi-dense-display — tighten the TUI's vertical space. Rendering only: the session
 * transcript and the model context always keep the original content.
 *
 * A. Markdown post-render filtering: drop blank rendered lines and ``` fence
 *    borders. Running after parsing and rendering leaves the markdown source,
 *    paragraph/heading structure and code highlighting intact.
 * B. Component-tree tightening: finished tool calls collapse to one clickable
 *    line (click / Ctrl+O expands; multi-line rows get a slightly lighter
 *    background); thinking runs always show as one collapsed line carrying the
 *    last thinking line — or nothing at all when "hideThinkingBlock" is true;
 *    the blank rows pi pads messages and turns with are removed.
 * C. The widget container above the editor keeps a Spacer even when empty,
 *    which draws a fixed blank line over the input box; containers holding
 *    nothing but Spacers now render as nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, MouseRegion, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type ThemeLike = {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	getBgAnsi(color: string): string;
};

// pi re-evaluates this file on /reload, so the state is shared on globalThis:
// wrappers installed by an earlier load keep seeing the theme captured by the
// current one (ctx.ui.theme is a live proxy, so it also follows theme changes).
const state: { theme?: ThemeLike } =
	((globalThis as any)[Symbol.for("zpi-dense-display")] ??= { theme: undefined });

/**
 * Replace a prototype method with `wrap(original)`. pi's own method is remembered
 * per prototype, so re-loading this extension swaps the implementation instead of
 * stacking another wrapper on top of the previous one. (Any other extension that
 * wrapped the same method afterwards is unwrapped too.)
 */
function hook(proto: any, method: string, wrap: (orig: any) => any): void {
	const original = (proto.__denseOriginal ??= {});
	const base = original[method] ?? proto[method];
	if (typeof base !== "function") return;
	original[method] = base;
	proto[method] = wrap(base);
}

/** One uncached rendered line — what the rows built here emit. */
const lineComponent = (render: (width: number) => string[]) => ({ render, invalidate() {} });

// truncateToWidth emits a reset before its ellipsis, which would drop the
// active background/italic styling: strip it and append the caller's ellipsis.
function truncateStyled(text: string, avail: number, ellipsis: string): string {
	if (visibleWidth(text) <= avail) return text;
	const head = avail > 1 ? truncateToWidth(text, avail - 1, "").replace(/\x1b\[0m$/, "") : "";
	return head + ellipsis;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// A. Markdown post-render filtering
// ---------------------------------------------------------------------------

/**
 * Drop blank lines and ``` fence borders. Border lines sit at the component's
 * base padding while code content lines sit two spaces deeper, so a literal
 * ``` inside code content (a nested fence example) is never mistaken for a border.
 */
function compactLines(lines: string[]): string[] {
	const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	const indentAt = (i: number) => plain[i].length - plain[i].trimStart().length;
	let base = Infinity;
	for (let i = 0; i < plain.length; i++) if (plain[i].trim()) base = Math.min(base, indentAt(i));
	return lines.filter((_, i) => plain[i].trim() && !(indentAt(i) === base && plain[i].startsWith("```", base)));
}

// ---------------------------------------------------------------------------
// B1. Tool calls collapse to one line
// ---------------------------------------------------------------------------

/**
 * The row shows one line of a tool's argument: the first line that actually has
 * content, so leading blank lines (multi-line commands, pasted code) are skipped
 * instead of shifting the label right.
 */
const firstLine = (text: string) => oneLine(text.split("\n").find((l) => l.trim()) ?? "");

const primaryArg = (args: any): string => {
	const v = args.command ?? args.path ?? args.pattern ?? args.query ?? args.filePath ??
		Object.values(args).find((x) => typeof x === "string");
	return typeof v === "string" ? firstLine(v) : "";
};

const textOutput = (result: any) => result.content.find((c: any) => c.type === "text")?.text ?? "";

const hasImages = (result: any) => result.content.some((c: any) => c.type === "image");

const diffStats = (diff: string) => {
	const lines = diff.split("\n");
	return {
		add: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
		rem: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
	};
};

/** `toolName 12s arg — outcome`, plus the flags worth keeping: diff size, truncation. */
function buildLine(comp: any, theme: ThemeLike): { bg: string; text: string } {
	const { result } = comp;
	const failed = result.isError === true;
	let text = theme.fg("toolTitle", theme.bold(comp.toolName));
	// Elapsed time sits between the name and the argument, rounded to whole
	// seconds, only past 5s, and tinted by outcome with the same theme tokens the
	// edit row uses for its +N / -M counts.
	if (result.durationMs >= 5000) {
		text += theme.fg(failed ? "error" : "success", ` ${Math.round(result.durationMs / 1000)}s`);
	}
	const arg = primaryArg(comp.args);
	if (arg) text += theme.fg("accent", ` ${arg}`);

	if (failed) {
		const outcome = oneLine(textOutput(result)) || "error";
		return { bg: "toolErrorBg", text: text + theme.fg("toolOutput", ` — ${outcome}`) };
	}
	if (typeof result.details?.diff === "string") {
		const { add, rem } = diffStats(result.details.diff);
		text += theme.fg("success", ` +${add}`) + theme.fg("error", ` -${rem}`);
	}
	if (result.details?.truncation?.truncated) text += theme.fg("warning", " [trunc]");
	return { bg: "toolSuccessBg", text };
}

// Multi-line rows get their background nudged toward white, so an expanded or
// streaming block reads differently from a flat collapsed row. Only the theme's
// own tool success/error backgrounds are touched, and rewriting them means a
// second pass finds nothing to replace.
const BG_LIGHTEN = 0.05;

function lightenToolBg(lines: string[], theme: ThemeLike): string[] {
	for (const token of ["toolSuccessBg", "toolErrorBg"]) {
		const from = theme.getBgAnsi(token);
		const m = from.match(/^\x1b\[48;2;(\d+);(\d+);(\d+)m$/);
		if (!m) continue; // 256-color or default background: nothing to mix
		const mix = (v: string) => Math.round(Number(v) + (255 - Number(v)) * BG_LIGHTEN);
		const to = `\x1b[48;2;${mix(m[1])};${mix(m[2])};${mix(m[3])}m`;
		lines = lines.map((l) => (l.includes(from) ? l.split(from).join(to) : l));
	}
	return lines;
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

		// Only a finished result collapses: streaming, executing, expanded and
		// image outputs keep pi's layout, with the padding already dropped.
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
		// pi applies outputPad only to the default-shell container, so self-shell
		// (edit) and renderer-less tools would otherwise collapse at the Box default.
		box.setPaddingX(this.outputPad);
		// Render through the Box, so the line carries the expanded content's
		// full-width background.
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
// B2. Thinking blocks: one collapsed line, or none
// ---------------------------------------------------------------------------

/** Last line of the last non-empty thinking block, collapsed to one line. */
function lastThinkingLine(content: any): string | undefined {
	const blocks = content.filter((c: any) => c.type === "thinking" && c.thinking.trim());
	const text: string = blocks[blocks.length - 1]?.thinking.trim() ?? "";
	return oneLine(text.slice(text.lastIndexOf("\n") + 1)) || undefined;
}

/**
 * pi renders a thinking run collapsed when
 * `thinkingVisibilityOverrides.get(run) ?? hideThinkingBlock` is truthy. A Map
 * that reports unknown runs as hidden collapses every run without touching the
 * user's setting; a click records an explicit false for that run, and pi's
 * setHideThinkingBlock clears the overrides.
 */
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

			// "hideThinkingBlock": true drops the row instead of collapsing it.
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

// pi's widget container above the editor carries a Spacer even when no
// extension widget is registered, which shows up as a fixed blank line between
// the transcript and the input box. A container whose children are all
// Spacers has no visible content, so such containers render as nothing;
// containers with real content (widget, header, pending messages) keep their
// leading spacers.
function patchSpacerOnlyContainers() {
	hook(Container.prototype as any, "render", (origRender) => function (this: any, width: number): string[] {
		const kids = this.children;
		if (kids?.length && kids.every((k: any) => k instanceof Spacer)) return [];
		return origRender.call(this, width);
	});
}

// ---------------------------------------------------------------------------
// B3. Turn-end spacer (see patchTurnEndSpacer)
// ---------------------------------------------------------------------------

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
