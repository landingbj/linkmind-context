/** Plugin configuration */
export interface LinkMindPluginConfig {
  /** LinkMind API URL */
  apiUrl?: string;
  /** Global log level */
  logLevel?: "debug" | "info" | "warn" | "error";
}
