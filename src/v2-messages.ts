import type {
	Api,
	Model,
	Tool,
	ToolResultMessage,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";

export const V2_STATE_SIGNATURE_PREFIX = "gigachat:v2:tool_state_id:";

interface V2Content {
	text?: string;
	function_call?: {
		id: string;
		name: string;
		arguments: Record<string, unknown>;
	};
	function_result?: { id: string; name: string; result: string };
}

interface V2Message {
	role: "system" | "user" | "assistant" | "reasoning" | "tool";
	content: V2Content[];
	tool_state_id?: string;
}

export function convertV2Messages(
	model: Model<Api>,
	context: TranscriptContext,
	additionalSystemPrompt?: string,
): V2Message[] {
	const messages: V2Message[] = [];
	const history = transformMessages(
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
		messages.push({
			role: "system",
			content: [{ text: systemPrompt.toWellFormed() }],
		});

	const pending = new Map<string, string>();
	for (const message of history) {
		if (message.role === "user") {
			pending.clear();
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			if (typeof message.content === "string" || text)
				messages.push({
					role: "user",
					content: [{ text: text.toWellFormed() }],
				});
			continue;
		}
		if (message.role === "assistant") {
			pending.clear();
			const content: V2Content[] = [];
			let state: string | undefined;
			const reasoning = message.content
				.filter((part) => part.type === "thinking" && !part.redacted)
				.map((part) => (part.type === "thinking" ? part.thinking : ""))
				.join("");
			if (reasoning)
				messages.push({
					role: "reasoning",
					content: [{ text: reasoning.toWellFormed() }],
				});
			for (const part of message.content) {
				let signature: string | undefined;
				if (part.type === "text") {
					content.push({ text: part.text.toWellFormed() });
					signature = part.textSignature;
				} else if (part.type === "toolCall") {
					content.push({
						function_call: {
							id: part.id,
							name: part.name,
							arguments: JSON.parse(JSON.stringify(part.arguments)),
						},
					});
					pending.set(part.id, part.name);
					signature = part.thoughtSignature;
				}
				if (signature?.startsWith(V2_STATE_SIGNATURE_PREFIX))
					state = signature.slice(V2_STATE_SIGNATURE_PREFIX.length);
			}
			if (content.length || state)
				messages.push({
					role: "assistant",
					content,
					...(state && { tool_state_id: state }),
				});
			continue;
		}
		const result = message as ToolResultMessage;
		const name = pending.get(result.toolCallId);
		pending.delete(result.toolCallId);
		if (name === undefined) {
			// Imported or truncated histories can have a result without its call.
			messages.push({
				role: "user",
				content: [
					{
						text: `Tool result (${result.toolName}):\n${toolResultText(result)}`.toWellFormed(),
					},
				],
			});
		} else {
			const content: V2Content = {
				function_result: {
					id: result.toolCallId,
					name,
					result: JSON.stringify({
						result: toolResultText(result),
						...(result.isError && { isError: true }),
					}),
				},
			};
			const previous = messages.at(-1);
			if (previous?.role === "tool") previous.content.push(content);
			else messages.push({ role: "tool", content: [content] });
		}
	}
	return messages;
}

function toolResultText(message: ToolResultMessage): string {
	const text =
		message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text.toWellFormed())
			.join("\n") || "(no content)";
	return message.isError ? `Error: ${text}` : text;
}

export function convertV2Functions(tools: Tool[]): Record<string, unknown>[] {
	return tools.map(({ name, description, parameters }) => ({
		name,
		description,
		parameters: JSON.parse(JSON.stringify(parameters)),
	}));
}
