export interface AgentConfig {
  apiUrl: string;
  webOrigin: string;
  internalSecret: string;
}
export function agentConfig(): AgentConfig {
  return {
    apiUrl: process.env.API_URL ?? "http://localhost:3001",
    webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
    internalSecret: process.env.FLUE_INTERNAL_SECRET ?? "",
  };
}
