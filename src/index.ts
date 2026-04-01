import type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineRuntimeContext,
} from "openclaw/plugin-sdk";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core";
import type { LinkMindPluginConfig } from "./types.js";
import { estimateTokens } from "./token-estimator.js";

// Derived from the ContextEngine interface (not directly exported from the SDK)
type AssembleResult = Awaited<ReturnType<ContextEngine["assemble"]>>;
type BootstrapResult = Awaited<
  ReturnType<NonNullable<ContextEngine["bootstrap"]>>
>;
type IngestResult = Awaited<ReturnType<ContextEngine["ingest"]>>;

const PLUGIN_ID = "linkmind-context" as const;
const DEFAULT_API_URL = "http://localhost:8080/v1";

type AssembleApiResponse = {
  status: string;
  messages: AgentMessage[];
  msg?: string;
};


type AfterTurnApiResponse = {
  status: string;
  msg?: string;
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

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    prompt: string;
  }): Promise<{ messages: AgentMessage[]; estimatedTokens: number }> {
    const response = await fetch(`${this.config.apiUrl}/openclaw/context/assemble`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: params.sessionId,
        messages: params.messages,
        prompt: params.prompt,
      }),
    });
    if (!response.ok) {
      throw new Error(`LinkMind assemble API error: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as AssembleApiResponse;
    if (data.status !== "success") {
      throw new Error(`LinkMind assemble API returned error: ${data.msg ?? "Unknown error"}`);
    }
    return { messages: data.messages, estimatedTokens: estimateTokens(data.messages) };
  }

  async afterTurn(params: {
    sessionId: string;
    messages: AgentMessage[];
  }): Promise<void> {
    const response = await fetch(`${this.config.apiUrl}/openclaw/context/afterTurn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: params.sessionId,
        messages: params.messages,
      }),
    });
    if (!response.ok) { 
      throw new Error(`LinkMind afterTurn API error: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as AfterTurnApiResponse;
    if (data.status !== "success") {
      throw new Error(`LinkMind afterTurn API returned error: ${data.msg ?? "Unknown error"}`);
    }
  }
}

class LinkMindContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: PLUGIN_ID,
    name: "LinkMind Intelligent Context Compression Engine",
    ownsCompaction: false,
  };

  private readonly client: LinkMindClient;

  constructor(config: LinkMindPluginConfig = {}) {
    this.client = new LinkMindClient(config);
  }

  async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    logger.debug(`Bootstrap complete, sessionId=${params.sessionId}`);
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
    logger.debug(`afterTurn: sessionId=${params.sessionId}, messages=${params.messages.length}`);
    if (params.isHeartbeat) {
      return;
    }
    try {
      await this.client.afterTurn({
        sessionId: params.sessionId,
        messages: params.messages,
      });
    } catch (err) {
      logger.error(`afterTurn failed, falling back to raw messages: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    return;
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    prompt: string;
  }): Promise<AssembleResult> {
    logger.debug(`assemble: sessionId=${params.sessionId}, messages=${params.messages.length}, prompt=${params.prompt}`);
    if (params.messages.length === 0 || params.prompt.length === 0) {
      return { messages: [], estimatedTokens: 0 };
    }
    try {
      return await this.client.assemble({
        sessionId: params.sessionId,
        messages: params.messages,
        prompt: params.prompt,
      });
    } catch (err) {
      logger.error(`assemble failed, falling back to raw messages: ${err instanceof Error ? err.message : String(err)}`);
      return { messages: params.messages, estimatedTokens: estimateTokens(params.messages) };
    }
  }

  async compact(
    params: Parameters<ContextEngine["compact"]>[0]
  ): Promise<Awaited<ReturnType<ContextEngine["compact"]>>> {
    return await delegateCompactionToRuntime(params);
  }

  async dispose(): Promise<void> {
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
