import type {
	ApiKeyCredential,
	OAuthCredential,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai";

export type GigaChatProtocol = "v1" | "v2" | "openai";

export interface ConnectionModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	temperature?: number;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

/** Imported PEM material owned by one server connection, never file references. */
export interface MtlsMaterials {
	ca: string;
	cert: string;
	key: string;
}

export interface Connection {
	/** Native provider identity; retained on same-name edits, replaced on rename. */
	id: string;
	/** Changes on a user edit, but not during token renewal. */
	revision: string;
	name: string;
	baseUrl: string;
	/** Legacy connections without a protocol use GigaChat V1. */
	protocol?: GigaChatProtocol;
	/** Explicit full catalog URL; omission selects the protocol default. */
	modelsUrl?: string;
	authorization:
		| { type: "token" }
		| { type: "credentials"; tokenUrl: string; scope: string }
		| { type: "mtls"; materials: MtlsMaterials };
	models: ConnectionModel[];
}

/** Configuration and its secret are committed as one native credential entry. */
export type ConnectionCredential = (ApiKeyCredential | OAuthCredential) & {
	gigachatConnection: Connection;
};

export interface ModelProbe {
	model: ConnectionModel;
	status: "available" | "unavailable";
	reason?: string;
}

export interface DiscoveryOptions {
	signal: AbortSignal;
	protocol?: GigaChatProtocol;
	modelsUrl?: string;
	mtls?: MtlsMaterials;
	progress?: (completed: number, total: number, probe?: ModelProbe) => void;
}
