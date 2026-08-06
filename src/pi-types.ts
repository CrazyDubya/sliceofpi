/**
 * Minimal structural typings for the Pi extension API surface sliceofpi uses.
 * Pi loads extensions via jiti at runtime; these types are intentionally
 * structural (duck-typed) so the extension works across Pi versions without a
 * hard dependency on @earendil-works/pi-coding-agent. Shapes follow that
 * package's docs/extensions.md and docs/session-format.md (v0.83).
 */

export interface TextContent {
	type: "text";
	text: string;
}

export type ContentBlock = TextContent | { type: string; [key: string]: unknown };

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { input?: number; output?: number; total?: number };
}

export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface AgentMessage {
	role: "user" | "assistant" | "toolResult" | string;
	content?: ContentBlock[] | string;
	/** toolResult linkage */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	usage?: Usage;
	timestamp?: number;
	customType?: string;
	[key: string]: unknown;
}

export interface SessionEntry {
	type: string;
	id: string;
	parentId?: string;
	customType?: string;
	data?: unknown;
	message?: AgentMessage;
	[key: string]: unknown;
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent?: number | null;
}

export interface UiApi {
	notify(text: string, level?: "info" | "warn" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget?(key: string, lines: string[] | undefined): void;
	confirm?(title: string, body?: string): Promise<boolean>;
}

export interface SessionManagerApi {
	getSessionFile(): string | undefined;
	getSessionId?(): string;
	getEntries?(): SessionEntry[];
	getBranchEntries?(): SessionEntry[];
}

export interface ExtensionContext {
	ui: UiApi;
	hasUI: boolean;
	cwd: string;
	sessionManager: SessionManagerApi;
	model?: { id?: string; contextWindow?: number; maxTokens?: number };
	getContextUsage(): ContextUsage | undefined;
	compact(opts?: {
		customInstructions?: string;
		onComplete?: (result: unknown) => void;
		onError?: (error: Error) => void;
	}): void;
	isIdle(): boolean;
	signal?: AbortSignal;
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: unknown;
	execute(
		args: Record<string, unknown>,
		ctx: ExtensionContext,
	): Promise<{ content: ContentBlock[]; isError?: boolean }>;
}

export interface ExtensionAPI {
	on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void;
	registerTool(def: ToolDefinition): void;
	registerCommand(
		name: string,
		opts: { description?: string; handler: (args: string, ctx: ExtensionContext) => unknown },
	): void;
	appendEntry(customType: string, data?: unknown): void;
	sendMessage?(
		message: { customType: string; content: string; display?: boolean },
		options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
	): void;
}
