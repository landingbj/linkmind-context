import type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineRuntimeContext,
} from "openclaw/plugin-sdk";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core";
import type { LinkMindPluginConfig } from "./types.js";

// Derived from the ContextEngine interface (not directly exported from the SDK)
type AssembleResult = Awaited<ReturnType<ContextEngine["assemble"]>>;
type BootstrapResult = Awaited<
  ReturnType<NonNullable<ContextEngine["bootstrap"]>>
>;
type IngestResult = Awaited<ReturnType<ContextEngine["ingest"]>>;

const PLUGIN_ID = "linkmind-context" as const;
const DEFAULT_API_URL = "http://localhost:8080/v1";
const DEFAULT_COMPRESSION_THRESHOLD = 1000;

type LinkMindApiResponse = {
  status: string;
  messages: AgentMessage[];
  tokensBefore?: number;
  tokensAfter?: number;
  error?: string;
};


type LogLevel = NonNullable<LinkMindPluginConfig["logLevel"]>;
const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const logger = {
  level: "info" as LogLevel,
  setLevel(level?: string): void {
    if (level && level in LOG_LEVEL_WEIGHT) {
      this.level = level as LogLevel;
    }
  },
  canLog(level: LogLevel): boolean {
    return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[this.level];
  },
  debug(message: string): void {
    if (this.canLog("debug")) {
      console.debug(`[LinkMind] ${message}`);
    }
  },
  info(message: string): void {
    if (this.canLog("info")) {
      console.info(`[LinkMind] ${message}`);
    }
  },
  warn(message: string): void {
    if (this.canLog("warn")) {
      console.warn(`[LinkMind] ${message}`);
    }
  },
  error(message: string): void {
    if (this.canLog("error")) {
      console.error(`[LinkMind] ${message}`);
    }
  },
};

class LinkMindClient {
  private readonly config: { apiUrl: string };

  constructor(config: LinkMindPluginConfig) {
    this.config = {
      apiUrl: config.apiUrl || DEFAULT_API_URL,
    };
  }

  getConfig(): { apiUrl: string } {
    return this.config;
  }

  async compress(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    currentTokenCount?: number;
  }): Promise<{ messages: AgentMessage[]; tokensAfter: number }> {
    const response = await fetch(`${this.config.apiUrl}/openclaw/compress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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
    ownsCompaction: false,
  };

  private readonly client: LinkMindClient;

  constructor(config: LinkMindPluginConfig = {}) {
    this.client = new LinkMindClient(config);
  }

  async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    logger.info(`Bootstrap complete, sessionId=${params.sessionId}`);
    return { bootstrapped: true };
  }

  async ingest(): Promise<IngestResult> {
    return { ingested: true };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void> {
    if (params.isHeartbeat) {
      return;
    }

    const totalChars = params.messages.reduce((sum, message) => sum + this.contentChars(message), 0);

    logger.info(`afterTurn: messages=${params.messages.length}, chars=${totalChars}, budget=${params.tokenBudget}`);

    if (totalChars <= DEFAULT_COMPRESSION_THRESHOLD) {
      return;
    }

    logger.info(
      `Threshold exceeded (chars=${totalChars} > threshold=${DEFAULT_COMPRESSION_THRESHOLD}), triggering compact...`
    );

  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    logger.info(`Context assembly complete, messages=${params.messages.length}`);

    return {
      messages: params.messages,
      estimatedTokens: 0,
    };
  }

  async compact(
    params: Parameters<ContextEngine["compact"]>[0]
  ): Promise<Awaited<ReturnType<ContextEngine["compact"]>>> {
    return await delegateCompactionToRuntime(params);
  }

  async dispose(): Promise<void> {
    logger.info("Resources released");
  }

  private contentChars(msg: AgentMessage): number {
    const content = "content" in msg ? msg.content : undefined;
    if (typeof content === "string") {
      return content.length;
    }

    if (Array.isArray(content)) {
      return content.reduce((sum, block) => {
        if (typeof block === "object" && block !== null && "text" in block) {
          return sum + (typeof block.text === "string" ? block.text.length : 0);
        }
        return sum;
      }, 0);
    }

    return 0;
  }
}

export function createPlugin(config: LinkMindPluginConfig = {}): ContextEngine {
  return new LinkMindContextEngine(config);
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "LinkMind Context Engine",
  description: "A context engine that compresses chat history using the LinkMind API.",
  kind: "context-engine",

  register(api) {
    const config: LinkMindPluginConfig = (api.pluginConfig ?? {}) as LinkMindPluginConfig;
    logger.setLevel(config.logLevel);
    logger.info(`Plugin initialized, preparing Context Engine... (logLevel=${logger.level})`);
    api.registerContextEngine(PLUGIN_ID, () => new LinkMindContextEngine(config));
    logger.info("Context Engine factory registered via registerContextEngine(id, factory)");
  },
});
