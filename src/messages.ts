import type {
	Api,
	Model,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";

export const STATE_SIGNATURE_PREFIX = "gigachat:functions_state_id:";

export function reasoningInContent(
	env: Record<string, string | undefined>,
): boolean {
	const mode = env.GIGACHAT_REASONING_IN_CONTENT ?? "false";
	if (mode !== "true" && mode !== "false")
		throw new Error("GIGACHAT_REASONING_IN_CONTENT must be true or false");
	return mode === "true";
}

interface GigaChatMessage {
	role: "system" | "user" | "assistant" | "function";
	content: string;
	reasoning_content?: string;
	reasoning?: string;
	name?: string;
	function_call?: { name: string; arguments: Record<string, unknown> };
}

export function convertMessages(
	model: Model<Api>,
	context: TranscriptContext,
	additionalSystemPrompt?: string,
	inContent = false,
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
			// Pi retains thinking only for the same provider/API/model and drops
			// foreign-model thinking before this point.
			const thinking = message.content.filter(
				(item): item is ThinkingContent =>
					item.type === "thinking" && !item.redacted,
			);
			const reasoningText = inContent
				? thinking.map((item) => item.thinking).join("")
				: "";
			const text = message.content
				.filter((item) => item.type === "text")
				.map((item) => sanitizeSurrogates(item.text))
				.join("");
			// Only change the outgoing representation; Pi's stored thinking stays
			// separate so repeated sends never modify or duplicate history.
			const content =
				inContent && reasoningText
					? `${sanitizeSurrogates(reasoningText)}${text ? `\n\n${text}` : ""}`
					: text;
			const native: { reasoning_content?: string; reasoning?: string } = {};
			if (!inContent) {
				for (const item of thinking) {
					const field = item.thinkingSignature;
					if (field === "reasoning_content" || field === "reasoning")
						native[field] =
							(native[field] ?? "") + sanitizeSurrogates(item.thinking);
				}
			}
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
						content: callIndex === 0 ? content : "",
						...(callIndex === 0 ? native : {}),
						function_call: { name: call.name, arguments: call.arguments },
					});
					const result = results.get(call.id);
					results.delete(call.id);
					messages.push({
						role: "function",
						name: call.name,
						content: JSON.stringify({
							result: result ? toolResultText(result) : "No result provided",
							...(result?.isError || !result ? { isError: true } : {}),
						}),
					});
				}
				for (const result of results.values()) {
					messages.push(unmatchedToolResult(result));
				}
			} else {
				messages.push({
					role: "assistant",
					content,
					...native,
				});
			}
			continue;
		}

		const toolMessage = message as ToolResultMessage;
		// A result without a preceding call can occur after a history cut or
		// importing a session. Preserve it as context without an invalid pair.
		messages.push(unmatchedToolResult(toolMessage));
	}

	return messages;
}

function unmatchedToolResult(message: ToolResultMessage): GigaChatMessage {
	return {
		role: "user",
		content: `Tool result (${message.toolName}):\n${toolResultText(message)}`,
	};
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
