import type { AgentMessage } from "@mariozechner/pi-agent-core";

const CHARS_PER_TOKEN = 4;
const TOOL_RESULT_CHARS_PER_TOKEN = 2;
const IMAGE_CHAR_ESTIMATE = 8000;

// Matches CJK, Hangul, Hiragana, Katakana, and other non-Latin scripts
// that typically tokenize at ~1 token per character.
const NON_LATIN_RE =
  /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/gu;
const CJK_SURROGATE_HIGH_RE = /[\uD840-\uD87E][\uDC00-\uDFFF]/g;

export function estimateStringChars(text: string): number {
  if (text.length === 0) return 0;
  const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
  if (nonLatinCount === 0) return text.length;
  const cjkSurrogates = (text.match(CJK_SURROGATE_HIGH_RE) ?? []).length;
  return text.length - cjkSurrogates + nonLatinCount * (CHARS_PER_TOKEN - 1);
}

export function estimateTokens(messages: AgentMessage[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += estimateMessageChars(msg);
  }
  return Math.ceil(Math.max(0, totalChars) / CHARS_PER_TOKEN);
}

function estimateMessageChars(msg: AgentMessage): number {
  if (!msg || typeof msg !== "object" || !("role" in msg)) return 0;

  const role = msg.role as string;
  const m = msg as unknown as Record<string, unknown>;

  if (role === "user") {
    const content = m.content;
    if (typeof content === "string") return estimateStringChars(content);
    if (Array.isArray(content)) return estimateContentBlockChars(content);
    return 0;
  }

  if (role === "assistant") {
    let chars = 0;
    const content = m.content;
    if (!Array.isArray(content)) return 0;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string")
        chars += estimateStringChars(b.text);
      else if (b.type === "thinking" && typeof b.thinking === "string")
        chars += b.thinking.length;
      else if (b.type === "toolCall") {
        try {
          chars += JSON.stringify(b.arguments ?? {}).length;
        } catch {
          chars += 128;
        }
      }
    }
    return chars;
  }

  if (role === "toolResult" || role === "tool") {
    const content = m.content;
    const rawChars =
      typeof content === "string"
        ? estimateStringChars(content)
        : Array.isArray(content)
          ? estimateContentBlockChars(content)
          : 0;
    // Tool results tokenize more densely: ~2 chars/token vs the normal 4
    return Math.ceil(rawChars * (CHARS_PER_TOKEN / TOOL_RESULT_CHARS_PER_TOKEN));
  }

  return 256;
}

function estimateContentBlockChars(content: unknown[]): number {
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string")
      chars += estimateStringChars(b.text);
    else if (b.type === "image") chars += IMAGE_CHAR_ESTIMATE;
    else {
      try {
        const s = JSON.stringify(block);
        chars += typeof s === "string" ? s.length : 0;
      } catch {
        chars += 256;
      }
    }
  }
  return chars;
}
