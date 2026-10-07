import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { GIGACHAT_API } from "./models.js";

const installationVersion = "0.4.0";

export function registerDefaultModel(
	pi: ExtensionAPI,
	canInitialize: (ctx: ExtensionContext) => boolean,
): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!canInitialize(ctx)) return;
		if (ctx.model?.api === GIGACHAT_API && ctx.model.provider !== "gigachat") {
			return;
		}
		// The Pi host is optional for programmatic pi-ai consumers.
		const { getAgentDir, SettingsManager } = await import(
			"@earendil-works/pi-coding-agent"
		);
		const agentDir = getAgentDir();
		const marker = join(agentDir, ".pi-gigachat-default-model");
		if (
			existsSync(marker) &&
			readFileSync(marker, "utf8").trim() === installationVersion
		) {
			return;
		}

		// Local-path installs and package managers that block lifecycle scripts
		// initialize the saved default on first activation instead.
		const settings = SettingsManager.create(ctx.cwd, agentDir);
		settings.setDefaultModelAndProvider("gigachat", "Qwen3.5-397b");
		await settings.flush();
		const errors = settings.drainErrors();
		if (errors.length) throw errors[0].error;

		const explicitSelection = process.argv.some((arg) =>
			/^(--model|--provider|--session|--resume|--continue|-c|-r)(=|$)/.test(
				arg,
			),
		);
		const projectDefault = settings.getProjectSettings().defaultModel;
		if (!explicitSelection && !projectDefault) {
			const model = ctx.modelRegistry.find("gigachat", "Qwen3.5-397b");
			if (model) await pi.setModel(model);
		}
		writeFileSync(marker, `${installationVersion}\n`, { mode: 0o600 });
	});
}
