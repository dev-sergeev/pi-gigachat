import type {
	Api,
	Context,
	Model,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";

export const STATE_SIGNATURE_PREFIX = "gigachat:functions_state_id:";
interface GigaChatMessage {
	role: "system" | "user" | "assistant" | "function";
	content: string;
	name?: string;
	functions_state_id?: string;
	function_call?: { name: string; arguments: Record<string, unknown> };
}

export function convertMessages(
	model: Model<Api>,
	context: Context,
	additionalSystemPrompt?: string,
): GigaChatMessage[] {
	const messages: GigaChatMessage[] = [];
	const transformedMessages = transformMessages(context.messages, model);
	const systemPrompt = [context.systemPrompt, additionalSystemPrompt?.trim()]
		.filter(Boolean)
		.join("\n\n");

	if (systemPrompt) {
		messages.push({
			role: "system",
			content: sanitizeSurrogates(systemPrompt),
		});
	}

	for (let i = 0; i < transformedMessages.length; i++) {
		const message = transformedMessages[i];
		if (message.role === "user") {
			if (typeof message.content === "string") {
				messages.push({
					role: "user",
					content: sanitizeSurrogates(message.content),
				});
			} else {
				const text = message.content
					.filter((item) => item.type === "text")
					.map((item) => sanitizeSurrogates(item.text))
					.join("\n");

				if (text.length > 0) {
					messages.push({ role: "user", content: text });
				}
			}
			continue;
		}

		if (message.role === "assistant") {
			const text = message.content
				.filter((item) => item.type === "text")
				.map((item) => sanitizeSurrogates(item.text))
				.join("");
			const toolCalls = message.content.filter(
				(item) => item.type === "toolCall",
			) as ToolCall[];

			if (toolCalls.length > 0) {
				const results = new Map<string, ToolResultMessage>();
				while (transformedMessages[i + 1]?.role === "toolResult") {
					const result = transformedMessages[++i] as ToolResultMessage;
					results.set(result.toolCallId, result);
				}
				// GigaChat accepts one function call per assistant message. Replay
				// parallel calls from other providers as ordered call/result pairs.
				for (const [callIndex, call] of toolCalls.entries()) {
					messages.push({
						role: "assistant",
						content: callIndex === 0 ? text : "",
						function_call: { name: call.name, arguments: call.arguments },
						functions_state_id: readStateSignature(call.thoughtSignature),
					});
					const result = results.get(call.id);
					messages.push({
						role: "function",
						name: call.name,
						content: JSON.stringify({
							result: result ? toolResultText(result) : "No result provided",
							...(result?.isError || !result ? { isError: true } : {}),
						}),
					});
				}
			} else {
				const signature = message.content.find(
					(block) =>
						block.type === "text" && readStateSignature(block.textSignature),
				);
				messages.push({
					role: "assistant",
					content: text,
					functions_state_id:
						signature?.type === "text"
							? readStateSignature(signature.textSignature)
							: undefined,
				});
			}
			continue;
		}

		const toolMessage = message as ToolResultMessage;
		// A result without a preceding call can occur after a history cut or
		// importing a session. Preserve it as context without an invalid pair.
		messages.push({
			role: "user",
			content: `Tool result (${toolMessage.toolName}):\n${toolResultText(toolMessage)}`,
		});
	}

	return messages;
}

function readStateSignature(signature?: string): string | undefined {
	return signature?.startsWith(STATE_SIGNATURE_PREFIX)
		? signature.slice(STATE_SIGNATURE_PREFIX.length)
		: undefined;
}

function toolResultText(message: ToolResultMessage): string {
	const text =
		message.content
			.filter((item) => item.type === "text")
			.map((item) => sanitizeSurrogates(item.text))
			.join("\n") || "(no content)";
	return message.isError ? `Error: ${text}` : text;
}

export function convertFunctions(tools: Tool[]): Record<string, unknown>[] {
	return tools.map(({ name, description, parameters }) => ({
		name,
		description,
		parameters: JSON.parse(JSON.stringify(parameters)),
	}));
}

function sanitizeSurrogates(text: string): string {
	return text.toWellFormed();
}
