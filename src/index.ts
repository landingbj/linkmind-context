import type {
  AgentMessage,
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngineMaintenanceResult,
  ContextEngine,
  ContextEngineInfo,
  ContextEngineRuntimeContext,
  IngestResult,
  LinkMindPluginConfig,
  TranscriptRewriteReplacement,
  TranscriptRewriteResult,
} from "./types.js";

const PLUGIN_ID = "linkmind-context" as const;
const DEFAULT_API_URL = "https://api.linkmind.dev/v1";
const DEFAULT_COMPRESSION_THRESHOLD = 1000;

type LinkMindApiResponse = {
  status: string;
  messages: AgentMessage[];
  tokensBefore?: number;
  tokensAfter?: number;
  error?: string;
};

class LinkMindClient {
  private readonly config: Required<LinkMindPluginConfig>;

  constructor(config: LinkMindPluginConfig) {
    this.config = {
      apiUrl: config.apiUrl || DEFAULT_API_URL,
      apiKey: config.apiKey || "",
      compressionThreshold: config.compressionThreshold || DEFAULT_COMPRESSION_THRESHOLD,
      debug: config.debug || false,
    };
  }

  getConfig(): Required<LinkMindPluginConfig> {
    return this.config;
  }

  async compress(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    currentTokenCount?: number;
  }): Promise<{ messages: AgentMessage[]; tokensAfter: number }> {
    if (this.config.debug) {
      console.log("[LinkMind] Calling compress API with", params.messages.length, "messages");
    }

    const response = await fetch(`${this.config.apiUrl}/openclaw/compress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        sessionId: params.sessionId,
        messages: params.messages,
        tokenBudget: params.tokenBudget,
        currentTokenCount: params.currentTokenCount,
      }),
    });

    if (!response.ok) {
      throw new Error(`[LinkMind] compress API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as LinkMindApiResponse;
    if (data.status !== "success") {
      throw new Error(`[LinkMind] compress API returned error: ${data.error ?? "unknown error"}`);
    }

    return {
      messages: data.messages,
      tokensAfter: data.tokensAfter ?? params.currentTokenCount ?? 0,
    };
  }
}

class LinkMindContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: PLUGIN_ID,
    name: "LinkMind Intelligent Context Compression Engine",
    version: "1.0.0",
    ownsCompaction: true,
  };

  private readonly client: LinkMindClient;
  private sessionId: string | undefined;
  private sessionFile: string | undefined;
  private pendingMessages: AgentMessage[] | undefined;
  private pendingRewriteMessages: AgentMessage[] | undefined;

  constructor(config: LinkMindPluginConfig = {}) {
    this.client = new LinkMindClient(config);
  }

  async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    this.sessionId = params.sessionId;
    this.sessionFile = params.sessionFile;

    if (this.client.getConfig().debug) {
      console.log(
        `[LinkMindPlugin] Initialization complete, session ID: ${params.sessionId}, session file: ${params.sessionFile}`
      );
    }

    return {
      bootstrapped: true,
      importedMessages: 0,
    };
  }

  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    if (params.isHeartbeat) {
      return { ingested: false };
    }

    if (this.client.getConfig().debug) {
      console.log(
        `[LinkMindPlugin] Message ingested (no storage), role: ${params.message.role}, chars: ${this.contentChars(params.message.content)}`
      );
    }

    return { ingested: true };
  }

  async maintain(params: {
    sessionId: string;
    sessionFile: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<ContextEngineMaintenanceResult> {
    if (!this.pendingRewriteMessages?.length) {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "no pending rewrite messages",
      };
    }

    return await this.applyTranscriptRewrite(this.pendingRewriteMessages, params.runtimeContext);
  }

  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
  }): Promise<void> {
    if (params.isHeartbeat) {
      return;
    }

    const config = this.client.getConfig();
    const totalChars = params.messages.reduce((sum, message) => sum + this.contentChars(message.content), 0);

    if (config.debug) {
      console.log(
        `[LinkMindPlugin] afterTurn: messages=${params.messages.length}, chars=${totalChars}, budget=${params.tokenBudget}`
      );
    }

    if (totalChars <= config.compressionThreshold) {
      return;
    }

    console.log(
      `[LinkMindPlugin] Threshold exceeded (chars=${totalChars} > threshold=${config.compressionThreshold}), triggering compact...`
    );

    this.pendingMessages = params.messages;
    try {
      await this.compact({
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        currentTokenCount: Math.ceil(totalChars / 4),
        ...(params.tokenBudget !== undefined && { tokenBudget: params.tokenBudget }),
        ...(params.runtimeContext !== undefined && { runtimeContext: params.runtimeContext }),
      });
    } finally {
      this.pendingMessages = undefined;
      this.pendingRewriteMessages = undefined;
    }
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    const estimatedTokens = params.messages.reduce(
      (sum, message) => sum + Math.ceil(this.contentChars(message.content) / 4),
      0
    );

    if (this.client.getConfig().debug) {
      console.log(
        `[LinkMindPlugin] Context assembly complete, total ${params.messages.length} messages, estimated tokens: ${estimatedTokens}`
      );
    }

    return {
      messages: params.messages,
      estimatedTokens,
    };
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<CompactResult> {
    const config = this.client.getConfig();
    const tokensBefore = params.currentTokenCount || 0;
    const messages = this.pendingMessages;

    if (config.debug) {
      console.log(`[LinkMindPlugin] Starting compression, current tokens: ${tokensBefore}, budget: ${params.tokenBudget}`);
    }

    if (!messages || messages.length === 0) {
      if (config.debug) {
        console.log("[LinkMindPlugin] No pending messages, skipping compression");
      }
      return { ok: true, compacted: false };
    }

    try {
      const result = await this.client.compress({
        sessionId: params.sessionId,
        messages,
        ...(params.tokenBudget !== undefined && { tokenBudget: params.tokenBudget }),
        currentTokenCount: tokensBefore,
      });

      this.pendingRewriteMessages = result.messages;
      const rewriteResult = await this.applyTranscriptRewrite(result.messages, params.runtimeContext);

      if (config.debug) {
        console.log(
          `[LinkMindPlugin] Compression complete, tokens before: ${tokensBefore}, after: ${result.tokensAfter}, rewritten: ${rewriteResult.rewrittenEntries}`
        );
      }

      if (!rewriteResult.changed) {
        return {
          ok: false,
          compacted: false,
          reason: rewriteResult.reason ?? "compression finished but transcript rewrite was not applied",
          result: {
            tokensBefore,
            tokensAfter: result.tokensAfter,
            details: {
              compressedMessages: result.messages.length,
              rewriteResult,
            },
          },
        };
      }

      return {
        ok: true,
        compacted: true,
        result: {
          tokensBefore,
          tokensAfter: result.tokensAfter,
          details: {
            compressedMessages: result.messages.length,
            compressionRatio: tokensBefore > 0 ? result.tokensAfter / tokensBefore : 1,
            rewriteResult,
          },
        },
      };
    } catch (error) {
      console.error("[LinkMindPlugin] Compression API call failed:", error);
      return {
        ok: false,
        compacted: false,
        reason: String(error),
      };
    }
  }

  async dispose(): Promise<void> {
    if (this.client.getConfig().debug) {
      console.log("[LinkMindPlugin] Resources released");
    }

    this.sessionId = undefined;
    this.sessionFile = undefined;
    this.pendingMessages = undefined;
    this.pendingRewriteMessages = undefined;
  }

  private contentChars(content: AgentMessage["content"]): number {
    if (typeof content === "string") {
      return content.length;
    }

    if (Array.isArray(content)) {
      return content.reduce((sum, block) => {
        return sum + (typeof block.text === "string" ? block.text.length : 0);
      }, 0);
    }

    return 0;
  }

  private async applyTranscriptRewrite(
    compressedMessages: AgentMessage[],
    runtimeContext?: ContextEngineRuntimeContext
  ): Promise<TranscriptRewriteResult> {
    const rewrite = runtimeContext?.rewriteTranscriptEntries;
    const sourceMessages = this.pendingMessages;

    if (typeof rewrite !== "function") {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "runtimeContext.rewriteTranscriptEntries is unavailable",
      };
    }

    if (!sourceMessages?.length || !compressedMessages.length) {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "no messages available for transcript rewrite",
      };
    }

    const replacements = this.buildRewriteReplacements(sourceMessages, compressedMessages);
    if (!replacements.length) {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "LinkMind returned messages that cannot be mapped to transcript entry ids",
      };
    }

    return await rewrite({ replacements });
  }

  private buildRewriteReplacements(
    sourceMessages: AgentMessage[],
    compressedMessages: AgentMessage[]
  ): TranscriptRewriteReplacement[] {
    const byId = new Map(
      sourceMessages.filter((message): message is AgentMessage & { id: string } => typeof message.id === "string").map((message) => [
        message.id,
        message,
      ])
    );

    const replacementsById = compressedMessages.flatMap((message) => {
      if (typeof message.id !== "string" || !byId.has(message.id)) {
        return [];
      }

      return [
        {
          entryId: message.id,
          message,
        },
      ];
    });

    if (replacementsById.length > 0) {
      return replacementsById;
    }

    if (sourceMessages.length !== compressedMessages.length) {
      return [];
    }

    return sourceMessages.flatMap((message, index) => {
      if (typeof message.id !== "string") {
        return [];
      }

      const compressedMessage = compressedMessages[index];
      if (!compressedMessage) {
        return [];
      }

      return [
        {
          entryId: message.id,
          message: {
            ...compressedMessage,
            id: message.id,
          },
        },
      ];
    });
  }
}

export function createPlugin(config: LinkMindPluginConfig = {}): ContextEngine {
  return new LinkMindContextEngine(config);
}

export default {
  id: PLUGIN_ID,
  name: "LinkMind Context Engine",
  description: "A context engine that compresses chat history using the LinkMind API.",
  kind: "context-engine" as const,

  register(api: any) {
    api.logger.info("[LinkMindPlugin] Plugin initialized, preparing Context Engine...");

    const config: LinkMindPluginConfig = api.pluginConfig ?? {};
    if (typeof api.registerContextEngine === "function") {
      api.registerContextEngine(PLUGIN_ID, () => new LinkMindContextEngine(config));
      api.logger.info("[LinkMindPlugin] Context Engine factory registered via registerContextEngine(id, factory)");
      return;
    }

    api.logger.error("[LinkMindPlugin] Error: registerContextEngine not found on API.");
    api.logger.error("[LinkMindPlugin] Available API keys:", Object.keys(api));
  },
};
