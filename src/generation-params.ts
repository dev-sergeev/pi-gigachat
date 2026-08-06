import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export type GigaChatResponseFormat =
	| { type: "text" }
	| {
			type: "json_schema";
			schema: Record<string, unknown>;
			strict?: boolean;
	  };

export interface GigaChatSamplingParams {
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	repetition_penalty?: number;
	update_interval?: number;
	/** Legacy gigachat-js 0.0.20 option; absent from the current REST v1 schema. */
	profanity_check?: boolean;
	response_format?: GigaChatResponseFormat;
}

export interface GigaChatGenerationOptions {
	topP?: number;
	repetitionPenalty?: number;
	updateInterval?: number;
	/** Legacy gigachat-js 0.0.20 option; absent from the current REST v1 schema. */
	profanityCheck?: boolean;
	responseFormat?: GigaChatResponseFormat;
	samplingParams?: GigaChatSamplingParams;
}

export type GigaChatGenerationParams = GigaChatSamplingParams;
export type GigaChatFlagReader = (name: string) => boolean | string | undefined;

type GigaChatModelWithSamplingParams = Model<Api> & {
	samplingParams?: GigaChatSamplingParams;
};
type GigaChatGenerationRuntimeOptions = SimpleStreamOptions &
	GigaChatGenerationOptions;
type SamplingParameterKey = keyof GigaChatSamplingParams;
type NumericParameterKey = Exclude<
	SamplingParameterKey,
	"profanity_check" | "response_format"
>;
type RawCandidate = {
	value: unknown;
	source: string;
	legacyMaxTokens?: boolean;
};
type RawLayer = Partial<Record<SamplingParameterKey, RawCandidate>>;

const MAX_INT_32 = 2_147_483_647;
const NUMERIC_PARAMETERS: ReadonlyArray<{
	key: NumericParameterKey;
	environment: string;
	flag: string;
	option:
		| "temperature"
		| "topP"
		| "maxTokens"
		| "repetitionPenalty"
		| "updateInterval";
	description: string;
	expectation: string;
	isValid: (value: number) => boolean;
}> = [
	{
		key: "temperature",
		environment: "GIGACHAT_TEMPERATURE",
		flag: "gigachat-temperature",
		option: "temperature",
		description: "GigaChat sampling temperature (> 0)",
		expectation: "a finite number greater than 0",
		isValid: (value) => value > 0,
	},
	{
		key: "top_p",
		environment: "GIGACHAT_TOP_P",
		flag: "gigachat-top-p",
		option: "topP",
		description: "GigaChat nucleus sampling probability (0..1)",
		expectation: "a finite number between 0 and 1",
		isValid: (value) => value >= 0 && value <= 1,
	},
	{
		key: "max_tokens",
		environment: "GIGACHAT_MAX_TOKENS",
		flag: "gigachat-max-tokens",
		option: "maxTokens",
		description: "Maximum GigaChat response tokens",
		expectation: `a positive 32-bit integer no greater than ${MAX_INT_32}`,
		isValid: (value) =>
			Number.isInteger(value) && value > 0 && value <= MAX_INT_32,
	},
	{
		key: "repetition_penalty",
		environment: "GIGACHAT_REPETITION_PENALTY",
		flag: "gigachat-repetition-penalty",
		option: "repetitionPenalty",
		description: "GigaChat repetition penalty (> 0)",
		expectation: "a finite number greater than 0",
		isValid: (value) => value > 0,
	},
	{
		key: "update_interval",
		environment: "GIGACHAT_UPDATE_INTERVAL",
		flag: "gigachat-update-interval",
		option: "updateInterval",
		description: "Minimum GigaChat stream update interval in seconds",
		expectation: "a non-negative finite number",
		isValid: (value) => value >= 0,
	},
];

export const GIGACHAT_GENERATION_FLAGS = NUMERIC_PARAMETERS.map(
	({ flag: name, description }) => ({ name, description }),
);

const SUPPORTED_SAMPLING_PARAMETER_KEYS = new Set<SamplingParameterKey>([
	...NUMERIC_PARAMETERS.map(({ key }) => key),
	"profanity_check",
	"response_format",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function samplingLayer(value: unknown, source: string): RawLayer {
	if (value === undefined) return {};
	if (!isPlainRecord(value)) {
		throw new Error(`Invalid ${source} value. Expected an object.`);
	}

	const layer: RawLayer = {};
	for (const [rawKey, parameterValue] of Object.entries(value)) {
		const key = rawKey as SamplingParameterKey;
		if (!SUPPORTED_SAMPLING_PARAMETER_KEYS.has(key)) {
			throw new Error(
				`Unsupported ${source} parameter "${rawKey}". Supported parameters: ${[...SUPPORTED_SAMPLING_PARAMETER_KEYS].join(", ")}.`,
			);
		}
		if (parameterValue !== undefined) {
			layer[key] = { value: parameterValue, source: `${source}.${rawKey}` };
		}
	}
	return layer;
}

function stringLayer(
	getValue: (environmentName: string, flagName: string) => string | undefined,
	getSource: (environmentName: string, flagName: string) => string,
): RawLayer {
	const layer: RawLayer = {};
	for (const parameter of NUMERIC_PARAMETERS) {
		const value = getValue(parameter.environment, parameter.flag);
		if (value !== undefined && value.trim() !== "") {
			layer[parameter.key] = {
				value,
				source: getSource(parameter.environment, parameter.flag),
			};
		}
	}
	return layer;
}

function environmentLayer(
	environment: Record<string, string | undefined>,
): RawLayer {
	return stringLayer(
		(environmentName) => environment[environmentName],
		(environmentName) => environmentName,
	);
}

function flagLayer(readFlag: GigaChatFlagReader | undefined): RawLayer {
	if (!readFlag) return {};
	return stringLayer(
		(_environmentName, flagName) => {
			const value = readFlag(flagName);
			return value === undefined ? undefined : String(value);
		},
		(_environmentName, flagName) => `--${flagName}`,
	);
}

function namedOptionsLayer(
	options: GigaChatGenerationRuntimeOptions | undefined,
): RawLayer {
	if (!options) return {};
	const layer: RawLayer = {};
	for (const parameter of NUMERIC_PARAMETERS) {
		const value = options[parameter.option];
		if (value !== undefined) {
			layer[parameter.key] = {
				value,
				source: `options.${parameter.option}`,
				legacyMaxTokens: parameter.key === "max_tokens",
			};
		}
	}
	if (options.profanityCheck !== undefined) {
		layer.profanity_check = {
			value: options.profanityCheck,
			source: "options.profanityCheck",
		};
	}
	if (options.responseFormat !== undefined) {
		layer.response_format = {
			value: options.responseFormat,
			source: "options.responseFormat",
		};
	}
	return layer;
}

function modelMaxTokensLayer(model: Model<Api>): RawLayer {
	return {
		max_tokens: {
			value: model.maxTokens,
			source: "model.maxTokens",
			legacyMaxTokens: true,
		},
	};
}

function selectCandidate(
	layers: readonly RawLayer[],
	key: SamplingParameterKey,
): RawCandidate | undefined {
	for (const layer of layers) {
		const candidate = layer[key];
		if (candidate) return candidate;
	}
	return undefined;
}

function selectSamplingStrategy(layers: readonly RawLayer[]): RawLayer {
	for (const layer of layers) {
		const temperature = layer.temperature;
		const topP = layer.top_p;
		if (temperature && topP) {
			throw new Error(
				"Invalid GigaChat generation configuration. temperature and top_p are alternatives; configure only one.",
			);
		}
		if (temperature) return { temperature };
		if (topP) return { top_p: topP };
	}
	return {};
}

function numericParameter(key: NumericParameterKey) {
	const parameter = NUMERIC_PARAMETERS.find((entry) => entry.key === key);
	if (!parameter) throw new Error(`Unknown GigaChat numeric parameter: ${key}`);
	return parameter;
}

function resolveNumber(
	key: NumericParameterKey,
	candidate: RawCandidate,
): number | undefined {
	const parameter = numericParameter(key);
	const numericValue =
		typeof candidate.value === "string"
			? Number(candidate.value.trim())
			: candidate.value;

	if (candidate.legacyMaxTokens && key === "max_tokens") {
		if (typeof numericValue !== "number" || !Number.isFinite(numericValue)) {
			return undefined;
		}
		const normalized = Math.floor(numericValue);
		return normalized > 0 && normalized <= MAX_INT_32 ? normalized : undefined;
	}

	if (
		typeof numericValue !== "number" ||
		!Number.isFinite(numericValue) ||
		!parameter.isValid(numericValue)
	) {
		throw new Error(
			`Invalid ${candidate.source} value. Expected ${parameter.expectation}.`,
		);
	}
	return numericValue;
}

function assertResponseFormat(
	value: unknown,
	source: string,
): asserts value is GigaChatResponseFormat {
	if (!isPlainRecord(value)) {
		throw new Error(
			`Invalid ${source} value. Expected a GigaChat response format object.`,
		);
	}
	if (value.type === "text") {
		if (Object.keys(value).some((key) => key !== "type")) {
			throw new Error(
				`Invalid ${source} value. Text response format only accepts the type field.`,
			);
		}
		return;
	}
	if (value.type !== "json_schema" || !isPlainRecord(value.schema)) {
		throw new Error(
			`Invalid ${source} value. Use { type: "text" } or { type: "json_schema", schema: { ... } }.`,
		);
	}
	if (value.strict !== undefined && typeof value.strict !== "boolean") {
		throw new Error(`Invalid ${source}.strict value. Expected true or false.`);
	}
	if (
		value.strict === true &&
		(!Array.isArray(value.schema.required) ||
			!value.schema.required.every((entry) => typeof entry === "string"))
	) {
		throw new Error(
			`Invalid ${source}.schema.required value. Strict JSON schema output requires an array of property names.`,
		);
	}
	try {
		JSON.stringify(value);
	} catch {
		throw new Error(
			`Invalid ${source} value. Expected JSON-serializable data.`,
		);
	}
}

export function resolveGigaChatGenerationParams(
	model: Model<Api>,
	options?: GigaChatGenerationRuntimeOptions,
	processEnvironment: Record<string, string | undefined> = process.env,
	readFlag?: GigaChatFlagReader,
): GigaChatGenerationParams {
	const layers: RawLayer[] = [
		samplingLayer(options?.samplingParams, "options.samplingParams"),
		namedOptionsLayer(options),
		flagLayer(readFlag),
		environmentLayer(options?.env ?? {}),
		environmentLayer(processEnvironment),
		samplingLayer(
			(model as GigaChatModelWithSamplingParams).samplingParams,
			"model.samplingParams",
		),
		modelMaxTokensLayer(model),
	];
	const selected = selectSamplingStrategy(layers);
	for (const key of [
		"max_tokens",
		"repetition_penalty",
		"update_interval",
		"profanity_check",
		"response_format",
	] as const) {
		const candidate = selectCandidate(layers, key);
		if (candidate) selected[key] = candidate;
	}

	const result: GigaChatGenerationParams = {};
	for (const key of NUMERIC_PARAMETERS.map(({ key }) => key)) {
		const candidate = selected[key];
		if (!candidate) continue;
		const value = resolveNumber(key, candidate);
		if (value !== undefined) {
			(result as Record<string, unknown>)[key] = value;
		}
	}
	const profanity = selected.profanity_check;
	if (profanity) {
		if (typeof profanity.value !== "boolean") {
			throw new Error(
				`Invalid ${profanity.source} value. Expected true or false.`,
			);
		}
		result.profanity_check = profanity.value;
	}
	const responseFormat = selected.response_format;
	if (responseFormat) {
		assertResponseFormat(responseFormat.value, responseFormat.source);
		result.response_format = responseFormat.value;
	}
	return result;
}
