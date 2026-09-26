import type { ReviewedTool } from "./policy.js";
// Inspected through authenticated official tools/list, 2026-09-27.
// SHA256 HumanOS canonical JSON {input: inputSchema, output: outputSchema ?? null}.
// Discovery must match these reviewed contracts; it never grants extra tools.
export const linearContracts: readonly ReviewedTool[] = Object.freeze([
  { name: "get_issue", schemaHash: "0xd641ed23c882979cf5a51ce94d4720d5af0c6439b9d5eb71ceb71a5262c97245" },
  { name: "save_issue", schemaHash: "0x8b61624d37b177d504589b655d8cc350ef223bfe04605787632f43a819722bf8" },
  { name: "list_teams", schemaHash: "0xec86728a06101d54edd4c14184721b4ebd49454eeeee47c86559e5e12de46135" },
  { name: "get_workspace", schemaHash: "0x93c97dcbc49a46a59947907c54efe71d43900bbee809ce22844bc36166038ded" },
]);
