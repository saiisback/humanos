import type { Mission } from "@humanos/schemas";
import { canPrepareMission } from "../mission.js";
/** Mounting is an affordance only: the API rechecks current state and policy. */
export function useCapabilities(mission: Mission | null): readonly string[] {
  return canPrepareMission(mission) ? ["prepare_next_action"] : [];
}
