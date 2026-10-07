import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type {
	KeybindingsManager,
	SelectItem,
	TUI,
} from "@earendil-works/pi-tui";
import {
	CURSOR_MARKER,
	Input,
	Key,
	matchesKey,
	SelectList,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ConnectionModel, ModelProbe } from "./connection-types.js";

export interface FormField {
	id: string;
	label: string;
	value?: string;
	placeholder?: string;
	secret?: boolean;
	choices?: readonly string[];
}

/** Preserve native editing/IME positions, but never return secret text to the TUI. */
function maskedInput(input: Input, width: number): string[] {
	const rendered = input.render(width);
	if (!input.getValue()) return rendered;
	return rendered.map((line) => {
		const cells = visibleWidth(stripTerminalSequences(line).trimEnd());
		const mask = "•".repeat(cells);
		const marker = line.indexOf(CURSOR_MARKER);
		if (marker < 0) return mask;
		const cursor = Math.min(visibleWidth(line.slice(0, marker)), width - 1);
		return (
			mask.slice(0, cursor) +
			CURSOR_MARKER +
			`\x1b[7m${cursor < cells ? "•" : " "}\x1b[27m` +
			mask.slice(cursor + 1)
		);
	});
}

class FormDialog {
	focused = true;
	private index = 0;
	private expanded = false;
	private readonly fields: (FormField & { input: Input })[];
	private readonly abort: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keys: KeybindingsManager,
		private readonly title: string,
		fields: FormField[],
		private readonly advanced: FormField[],
		private readonly done: (values: Record<string, string> | undefined) => void,
		private readonly signal?: AbortSignal,
	) {
		this.fields = [...fields, ...advanced].map((field) => {
			const input = new Input({ prompt: "", placeholder: field.placeholder });
			input.setValue(field.value ?? "");
			input.onSubmit = () => this.advance();
			input.onEscape = () => done(undefined);
			return { ...field, input };
		});
		this.abort = () => done(undefined);
		signal?.addEventListener("abort", this.abort, { once: true });
	}

	private count(): number {
		return this.expanded
			? this.fields.length
			: this.fields.length - this.advanced.length;
	}

	private advance(): void {
		if (this.index < this.count() - 1) this.index++;
		else this.submit();
		this.tui.requestRender();
	}

	private submit(): void {
		const values: Record<string, string> = {};
		for (const field of this.fields) values[field.id] = field.input.getValue();
		this.done(values);
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel")) {
			this.done(undefined);
		} else if (this.advanced.length && matchesKey(data, Key.ctrl("o"))) {
			this.expanded = !this.expanded;
			this.index = Math.min(this.index, this.count() - 1);
		} else if (
			matchesKey(data, Key.tab) ||
			this.keys.matches(data, "tui.select.down")
		) {
			this.index = (this.index + 1) % (this.count() + 1);
		} else if (
			matchesKey(data, Key.shift("tab")) ||
			this.keys.matches(data, "tui.select.up")
		) {
			this.index = (this.index + this.count()) % (this.count() + 1);
		} else if (this.index === this.count()) {
			if (this.keys.matches(data, "tui.select.confirm")) this.submit();
		} else {
			const field = this.fields[this.index];
			if (field.choices) {
				if (this.keys.matches(data, "tui.select.confirm")) this.advance();
				else if (
					matchesKey(data, Key.left) ||
					matchesKey(data, Key.right) ||
					matchesKey(data, Key.space)
				) {
					const delta = matchesKey(data, Key.left) ? -1 : 1;
					const current = Math.max(
						0,
						field.choices.indexOf(field.input.getValue()),
					);
					field.input.setValue(
						field.choices[
							(current + delta + field.choices.length) % field.choices.length
						],
					);
				}
			} else field.input.handleInput(data);
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines = [
			this.theme.fg("border", "─".repeat(width)),
			this.theme.fg("accent", this.title),
			"",
		];
		const inputWidth = Math.max(1, width - 4);
		for (let i = 0; i < this.count(); i++) {
			const field = this.fields[i];
			field.input.focused = this.focused && this.index === i;
			lines.push(
				this.theme.fg(
					this.index === i ? "accent" : "text",
					`${this.index === i ? "→" : " "} ${field.label}`,
				),
			);
			const value = field.choices
				? [`‹ ${field.input.getValue()} ›`]
				: field.secret
					? maskedInput(field.input, inputWidth)
					: field.input.render(inputWidth);
			for (const line of value) lines.push(`  ${line}`);
			lines.push("");
		}
		lines.push(
			this.theme.fg(
				this.index === this.count() ? "accent" : "muted",
				`${this.index === this.count() ? "→" : " "} Продолжить`,
			),
		);
		lines.push(
			this.theme.fg(
				"dim",
				`Enter: далее · Tab/↑↓: поле · Esc: отмена${this.advanced.length ? " · Ctrl+O: дополнительно" : ""}`,
			),
		);
		lines.push(this.theme.fg("border", "─".repeat(width)));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		for (const field of this.fields) field.input.invalidate();
	}

	dispose(): void {
		this.signal?.removeEventListener("abort", this.abort);
		for (const field of this.fields) field.input.setValue("");
	}
}

export async function showForm(
	ctx: ExtensionContext,
	title: string,
	fields: FormField[],
	advanced: FormField[] = [],
	signal?: AbortSignal,
): Promise<Record<string, string> | undefined> {
	if (signal?.aborted) return undefined;
	return ctx.ui.custom(
		(tui, theme, keys, done) =>
			new FormDialog(tui, theme, keys, title, fields, advanced, done, signal),
	);
}

export function chooseModels(
	ctx: ExtensionContext,
	probes: ModelProbe[],
	initial: readonly ConnectionModel[] = [],
): Promise<ConnectionModel[] | undefined> {
	return ctx.ui.custom((tui, theme, keys, done) => {
		const selected = new Set(initial.map((model) => model.id));
		const items: SelectItem[] = probes.map((probe) => ({
			value: probe.model.id,
			label: "",
			description:
				probe.status === "available" ? probe.model.name : probe.reason,
		}));
		const list = new SelectList(items, 10, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("dim", text),
		});
		let error = "";
		const refresh = () => {
			for (let i = 0; i < probes.length; i++) {
				const probe = probes[i];
				if (probe.status !== "available") selected.delete(probe.model.id);
				items[i].label =
					`${probe.status !== "available" ? "[—]" : selected.has(probe.model.id) ? "[x]" : "[ ]"} ${probe.model.id}`;
			}
			error = "";
			tui.requestRender();
		};
		refresh();
		return {
			render(width) {
				return [
					theme.fg("border", "─".repeat(width)),
					theme.fg("accent", "Выберите модели GigaChat"),
					theme.fg("muted", "Выбираются только успешно проверенные модели."),
					...list.render(width),
					...(error ? [theme.fg("error", error)] : []),
					theme.fg(
						"dim",
						"Space: отметить · Ctrl+A: все доступные · Enter: сохранить выбор · Esc: отмена",
					),
					theme.fg("border", "─".repeat(width)),
				].map((line) => truncateToWidth(line, width));
			},
			handleInput(data) {
				if (keys.matches(data, "tui.select.cancel")) done(undefined);
				else if (keys.matches(data, "tui.select.confirm")) {
					const models = probes
						.filter(
							(probe) =>
								probe.status === "available" && selected.has(probe.model.id),
						)
						.map((probe) => probe.model);
					if (models.length) done(models);
					else {
						error = "Отметьте хотя бы одну доступную модель.";
						tui.requestRender();
					}
				} else if (matchesKey(data, Key.ctrl("a"))) {
					for (const probe of probes)
						if (probe.status === "available") selected.add(probe.model.id);
					refresh();
				} else if (matchesKey(data, Key.space)) {
					const item = list.getSelectedItem();
					if (
						item &&
						probes.find((probe) => probe.model.id === item.value)?.status ===
							"available"
					) {
						if (selected.has(item.value)) selected.delete(item.value);
						else selected.add(item.value);
						refresh();
					}
				} else {
					list.handleInput(data);
					tui.requestRender();
				}
			},
			invalidate() {
				list.invalidate();
			},
		};
	});
}

export function runProgress<T>(
	ctx: ExtensionContext,
	title: string,
	work: (signal: AbortSignal, update: (message: string) => void) => Promise<T>,
): Promise<{ value: T } | { error: unknown } | undefined> {
	return ctx.ui.custom((tui, theme, keys, done) => {
		const controller = new AbortController();
		let message = title;
		let rendered: string[] | undefined;
		let renderedWidth = 0;
		let settled = false;
		const finish = (result: { value: T } | { error: unknown } | undefined) => {
			if (settled) return;
			settled = true;
			done(result);
		};
		void work(controller.signal, (text) => {
			if (!settled) {
				message = text;
				rendered = undefined;
				tui.requestRender();
			}
		}).then(
			(value) => finish({ value }),
			(error: unknown) => {
				if (!controller.signal.aborted) finish({ error });
			},
		);
		return {
			render(width) {
				if (!rendered || renderedWidth !== width) {
					renderedWidth = width;
					rendered = [
						theme.fg("border", "─".repeat(width)),
						theme.fg("accent", title),
						"",
						message,
						"",
						theme.fg("dim", "Esc: отменить запросы"),
						theme.fg("border", "─".repeat(width)),
					].map((line) => truncateToWidth(line, width));
				}
				return rendered;
			},
			handleInput(data) {
				if (
					keys.matches(data, "tui.select.cancel") ||
					keys.matches(data, "app.interrupt")
				) {
					controller.abort();
					finish(undefined);
				}
			},
			invalidate() {
				rendered = undefined;
			},
			dispose() {
				controller.abort();
			},
		};
	});
}
