import { createAgentRouter } from "@flue/runtime/routing";
import { HumanOS } from "./agents/humanos.js";
import { createProtectedApp } from "./http.js";
import { agentConfig } from "./config.js";
export default createProtectedApp(agentConfig(), createAgentRouter(HumanOS));
