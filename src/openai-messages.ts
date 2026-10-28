import type {
	Api,
	Model,
	Tool,
	ToolResultMessage,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";

interface GigaChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	tool_call_id?: string;
	tool_calls?: {
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}[];
}

export function convertMessages(
	model: Model<Api>,
	context: TranscriptContext,
	additionalSystemPrompt?: string,
): GigaChatMessage[] {
	const messages: GigaChatMessage[] = [];
	const transformedMessages = transformMessages(
		context.messages.filter((message) => message.role !== "system"),
		model,
	);
	const systemPrompt = [
		getCurrentSystemPrompt(context.messages),
		additionalSystemPrompt?.trim(),
	]
		.filter(Boolean)
		.join("\n\n");
	if (systemPrompt)
		messages.push({ role: "system", content: systemPrompt.toWellFormed() });
	const pendingCallIds = new Set<string>();
	const orphanResults: GigaChatMessage[] = [];
	for (const message of transformedMessages) {
		if (message.role !== "toolResult") {
			for (const orphan of orphanResults) messages.push(orphan);
			orphanResults.length = 0;
			pendingCallIds.clear();
		}
		if (message.role === "user") {
			const content =
				typeof message.content === "string"
					? message.content.toWellFormed()
					: message.content
							.filter((item) => item.type === "text")
							.map((item) => item.text.toWellFormed())
							.join("\n");
			if (content) messages.push({ role: "user", content });
		} else if (message.role === "assistant") {
			const thinking = message.content
				.filter((item) => item.type === "thinking" && !item.redacted)
				.map((item) => (item.type === "thinking" ? item.thinking : ""))
				.join("");
			const text = message.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("");
			const content = (
				thinking ? `${thinking}${text ? `\n\n${text}` : ""}` : text
			).toWellFormed();
			const tool_calls = message.content
				.filter((item) => item.type === "toolCall")
				.map((call) => {
					pendingCallIds.add(call.id);
					return {
						id: call.id,
						type: "function" as const,
						function: {
							name: call.name,
							arguments: JSON.stringify(call.arguments),
						},
					};
				});
			messages.push({
				role: "assistant",
				content,
				...(tool_calls.length ? { tool_calls } : {}),
			});
		} else if (message.role === "toolResult") {
			const content = toolResultText(message);
			if (pendingCallIds.delete(message.toolCallId)) {
				messages.push({
					role: "tool",
					tool_call_id: message.toolCallId,
					content,
				});
			} else {
				// Finish the contiguous tool exchange before retaining orphan context.
				orphanResults.push({
					role: "user",
					content: `Tool result (${message.toolName}):\n${content}`,
				});
			}
		}
	}
	for (const orphan of orphanResults) messages.push(orphan);
	return messages;
}

function toolResultText(message: ToolResultMessage): string {
	const text =
		message.content
			.filter((item) => item.type === "text")
			.map((item) => item.text.toWellFormed())
			.join("\n") || "(no content)";
	return message.isError ? `Error: ${text}` : text;
}

export function convertTools(tools: Tool[]): Record<string, unknown>[] {
	return tools.map(({ name, description, parameters }) => ({
		type: "function",
		function: { name, description, parameters },
	}));
}
