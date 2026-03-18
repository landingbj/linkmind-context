/**
 * OpenClaw LinkMind Context Engine Plugin
 * Strictly follows the official OpenClaw ContextEngine interface specification
 */

import type {
  LinkMindPluginConfig,
  ContextEngine,
  ContextEngineInfo,
  BootstrapResult,
  IngestResult,
  IngestBatchResult,
  AssembleResult,
  CompactResult,
  SubagentSpawnPreparation,
  SubagentEndReason,
  AgentMessage,
} from './types.js';


/** LinkMind API Client */
class LinkMindClient {
  private config: Required<LinkMindPluginConfig>;

  constructor(config: LinkMindPluginConfig) {
    this.config = {
      apiUrl: config.apiUrl || 'https://api.linkmind.dev/v1',
      apiKey: config.apiKey || '',
      compressionThreshold: config.compressionThreshold || 1000,
      debug: config.debug || false
    };
  }

  /** Get configuration */
  getConfig() {
    return this.config;
  }


  /**
   * Compress messages via LinkMind API.
   * Currently calls the stub endpoint which logs the data and returns messages unchanged.
   * @param params Compression parameters including messages and token counts
   */
  async compress(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    currentTokenCount?: number;
  }): Promise<{ messages: AgentMessage[]; tokensAfter: number }> {
    if (this.config.debug) {
      console.log('[LinkMind] Calling compress API with', params.messages.length, 'messages');
    }

    const body = JSON.stringify({
      sessionId: params.sessionId,
      messages: params.messages,
      tokenBudget: params.tokenBudget,
      currentTokenCount: params.currentTokenCount,
    });

    const response = await fetch(`${this.config.apiUrl}/openclaw/compress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { 'Authorization': `Bearer ${this.config.apiKey}` } : {}),
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`[LinkMind] compress API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      status: string;
      messages: AgentMessage[];
      tokensBefore: number;
      tokensAfter: number;
      error?: string;
    };

    if (data.status !== 'success') {
      throw new Error(`[LinkMind] compress API returned error: ${data.error}`);
    }

    return {
      messages: data.messages,
      tokensAfter: data.tokensAfter ?? params.currentTokenCount ?? 0,
    };
  }

  /**
   * Estimate token count for text
   * @param content Text content to estimate
   */
  estimateTokens(content: string): number {
    // Simple estimation: characters / 4 (recommended by OpenClaw)
    return Math.ceil(content.length / 4);
  }

}

/**
 * LinkMind Context Engine Plugin Implementation
 * Fully implements the official OpenClaw ContextEngine interface
 */
class LinkMindContextEngine implements ContextEngine {
  /** Engine metadata */
  public readonly info: ContextEngineInfo = {
    id: 'linkmind-context',
    name: 'LinkMind Intelligent Context Compression Engine',
    version: '1.0.0',
    ownsCompaction: true, // We manage compression lifecycle ourselves
  };

  private client: LinkMindClient;
  private sessionId: string | undefined;
  private sessionFile: string | undefined;
  /** Messages cached from the latest afterTurn() call, used by compact() */
  private _pendingMessages: AgentMessage[] | undefined;

  /**
   * Constructor receives plugin configuration (OpenClaw instantiates and passes config when loading plugin)
   * @param config Plugin configuration
   */
  constructor(config: LinkMindPluginConfig = {}) {
    this.client = new LinkMindClient(config);
  }


  /**
   * 1. Initialize engine state
   * @param params Initialization parameters, containing session ID and session file path
   */
  async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    this.sessionId = params.sessionId;
    this.sessionFile = params.sessionFile;

    const config = this.client.getConfig();
    if (config.debug) {
      console.log(`[LinkMindPlugin] Initialization complete, session ID: ${params.sessionId}, session file: ${params.sessionFile}`);
    }

    return {
      bootstrapped: true,
      importedMessages: 0,
    };
  }

  /**
   * Helper: extract the total character count from a message's content field.
   * content may be a plain string OR an array of content blocks
   * (e.g. [{ type: "text", text: "..." }, { type: "image", ... }]).
   * Typed as unknown to handle both the declared string type and the actual
   * runtime array format that OpenClaw passes.
   */
  private contentChars(content: unknown): number {
    if (typeof content === "string") {
      return content.length;
    }
    if (Array.isArray(content)) {
      return (content as Array<{ type: string; text?: string }>).reduce((sum, block) => {
        return sum + (typeof block.text === "string" ? block.text.length : 0);
      }, 0);
    }
    return 0;
  }

  /**
   * 2. Ingest single message
   * @param params Ingest parameters
   */
  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    // Skip heartbeat messages
    if (params.isHeartbeat) {
      return { ingested: false };
    }

    const config = this.client.getConfig();
    if (config.debug) {
      console.log(`[LinkMindPlugin] Message ingested (no storage), role: ${params.message.role}, chars: ${this.contentChars(params.message.content)}`);
    }

    // No storage needed, OpenClaw runtime maintains messages
    return { ingested: true };
  }



  /**
   * 4. Post-turn hook — called by OpenClaw after every agent run completes.
   * When ownsCompaction is true, this is the ONLY place the engine is notified
   * to decide whether to compress; OpenClaw will NOT call compact() on its own.
   */
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
    // Skip heartbeat turns — they carry no real user/assistant content
    if (params.isHeartbeat) return;

    const config = this.client.getConfig();

    // Estimate total context size in characters
    let totalChars = 0;
    for (const msg of params.messages) {
      totalChars += this.contentChars(msg.content);
    }

    if (config.debug) {
      console.log(
        `[LinkMindPlugin] afterTurn: messages=${params.messages.length}, chars=${totalChars}, budget=${params.tokenBudget}`
      );
    }

    // Trigger compaction when accumulated chars exceed the configured threshold
    if (totalChars > config.compressionThreshold) {
      console.log(
        `[LinkMindPlugin] 🔥 Threshold exceeded (chars=${totalChars} > threshold=${config.compressionThreshold}), triggering compact...`
      );
      // Cache messages so compact() can access them
      this._pendingMessages = params.messages;
      await this.compact({
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        currentTokenCount: Math.ceil(totalChars / 4),
        // Spread optional fields only when defined to satisfy exactOptionalPropertyTypes
        ...(params.tokenBudget !== undefined && { tokenBudget: params.tokenBudget }),
        ...(params.runtimeContext !== undefined && { runtimeContext: params.runtimeContext }),
      });
      this._pendingMessages = undefined;
    }
  }

  /**
   * 5. Context assembly
   * @param params Assembly parameters
   */
  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    // Use only the provided messages (OpenClaw runtime maintains history)
    const messages = params.messages;

    // Estimate total token count (chars / 4 per OpenClaw recommendation)
    let estimatedTokens = 0;
    for (const msg of messages) {
      estimatedTokens += Math.ceil(this.contentChars(msg.content) / 4);
    }

    const config = this.client.getConfig();
    if (config.debug) {
      console.log(`[LinkMindPlugin] Context assembly complete, total ${messages.length} messages, estimated tokens: ${estimatedTokens}`);
    }

    return {
      messages,
      estimatedTokens,
    };
  }

  /**
   * 6. Context compression
   * @param params Compression parameters
   */
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

    // Use provided current token count
    const tokensBefore = params.currentTokenCount || 0;

    if (config.debug) {
      console.log(`[LinkMindPlugin] Starting compression, current tokens: ${tokensBefore}, budget: ${params.tokenBudget}`);
    }

    const messages = this._pendingMessages;
    if (!messages || messages.length === 0) {
      if (config.debug) console.log('[LinkMindPlugin] No pending messages, skipping compression');
      return { ok: true, compacted: false };
    }

    try {
      const result = await this.client.compress({
        sessionId: params.sessionId,
        messages,
        ...(params.tokenBudget !== undefined && { tokenBudget: params.tokenBudget }),
        currentTokenCount: tokensBefore,
      });

      const tokensAfter = result.tokensAfter;

      if (config.debug) {
        console.log(`[LinkMindPlugin] Compression complete, tokens before: ${tokensBefore}, after: ${tokensAfter}`);
      }

      return {
        ok: true,
        compacted: true,
        result: {
          tokensBefore,
          tokensAfter,
          details: {
            compressedMessages: result.messages.length,
            compressionRatio: tokensBefore > 0 ? tokensAfter / tokensBefore : 1,
          },
        },
      };
    } catch (err) {
      console.error('[LinkMindPlugin] Compression API call failed:', err);
      return {
        ok: false,
        compacted: false,
        reason: String(err),
      };
    }
  }



  /**
   * 9. Dispose resources
   */
  async dispose(): Promise<void> {
    const config = this.client.getConfig();
    if (config.debug) {
      console.log('[LinkMindPlugin] Resources released');
    }

    this.sessionId = undefined;
    this.sessionFile = undefined;
  }
}

/**
 * Factory function to create plugin instance
 * OpenClaw calls this function and passes configuration when loading plugin
 * @param config Plugin configuration
 */
export function createPlugin(config: LinkMindPluginConfig = {}): ContextEngine {
  return new LinkMindContextEngine(config);
}

/**
 * Standard OpenClaw plugin export format
 */
export default {
  id: "linkmind-context",
  name: "LinkMind Context Engine",
  description: "A context engine that compresses chat history using LinkMind API",

  register(api: any) {
    api.logger.info("[LinkMindPlugin] Plugin initialized, preparing Context Engine...");

    const config: LinkMindPluginConfig = api.pluginConfig || {
      debug: true,
      compressionThreshold: 50,
    };

    // registerContextEngine expects (id: string, factory: () => ContextEngine)
    // NOT a direct engine instance — the factory is called by OpenClaw when the
    // engine slot is resolved for each session.
    if (typeof api.registerContextEngine === 'function') {
      api.registerContextEngine(
        "linkmind-context",
        () => new LinkMindContextEngine(config)
      );
      api.logger.info("[LinkMindPlugin] Context Engine factory registered via registerContextEngine(id, factory)");
    } else {
      api.logger.error("[LinkMindPlugin] Error: registerContextEngine not found on API.");
      api.logger.error("[LinkMindPlugin] Available API keys:", Object.keys(api));
    }
  },

  activate(api: any) {
    // Activation logic if needed
    api.logger.info("[LinkMindPlugin] Plugin activated");
  }
};

