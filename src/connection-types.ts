import type {
	ApiKeyCredential,
	OAuthCredential,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai";

export interface ConnectionModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	temperature?: number;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

export interface Connection {
	/** Native provider identity; retained on same-name edits, replaced on rename. */
	id: string;
	/** Changes on a user edit, but not during token renewal. */
	revision: string;
	name: string;
	baseUrl: string;
	authorization:
		| { type: "token" }
		| { type: "credentials"; tokenUrl: string; scope: string };
	models: ConnectionModel[];
}

/** Configuration and its secret are committed as one native credential entry. */
export type ConnectionCredential = (ApiKeyCredential | OAuthCredential) & {
	gigachatConnection: Connection;
};

export interface ModelProbe {
	model: ConnectionModel;
	status: "available" | "unavailable" | "unverified";
	reason?: string;
}

export interface DiscoveryOptions {
	signal: AbortSignal;
	progress?: (completed: number, total: number, probe?: ModelProbe) => void;
}
