import type {
  ActionProposal,
  Approval,
  ExecutionReceipt,
  JevAssessment,
  Mission,
  PolicyDecision,
} from "@humanos/schemas";

export type TranscriptItem =
  | { kind: "human"; id: string; text: string; at?: string }
  | { kind: "agent"; id: string; text: string; at?: string }
  | { kind: "progress"; id: string; text: string; terminal?: boolean }
  | { kind: "identity"; id: string; text: string; verified: boolean }
  | { kind: "mandate"; id: string; mission: Mission }
  | { kind: "ens"; id: string; name: string; expiresAt: string }
  | {
      kind: "approval";
      id: string;
      action: ActionProposal;
      approval: Approval | null;
      effect: string;
      payloadHash: string;
      assessment: JevAssessment | null;
      decision: PolicyDecision | null;
    }
  | { kind: "denial"; id: string; text: string; terminal: true }
  | { kind: "receipt"; id: string; receipt: ExecutionReceipt; terminal: true };
