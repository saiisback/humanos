import type {
  ActionType,
  ActionProposalDraft,
  Capability,
  RiskLevel,
} from "@humanos/schemas";
import { PolicyError } from "./errors.js";
export const STATIC_RULES: Record<
  ActionType,
  { capability: Capability; risk: RiskLevel }
> = {
  READ_DOCUMENT: { capability: "documents.read", risk: "ROUTINE" },
  DISCLOSE_DOCUMENT: { capability: "documents.disclose", risk: "SENSITIVE" },
  WRITE_DRAFT: { capability: "drafts.write", risk: "ROUTINE" },
  SEARCH_WEB: { capability: "web.search", risk: "ROUTINE" },
  WRITE_CHECKLIST: { capability: "checklist.write", risk: "ROUTINE" },
  CREATE_CALENDAR_EVENT: {
    capability: "calendar.create",
    risk: "CONSEQUENTIAL",
  },
  SEND_EMAIL: { capability: "email.send", risk: "CONSEQUENTIAL" },
  SAVE_FORM: { capability: "form.save", risk: "CONSEQUENTIAL" },
  UPLOAD_DATA: { capability: "data.upload", risk: "CONSEQUENTIAL" },
  SUBMIT_APPLICATION: { capability: "application.submit", risk: "SENSITIVE" },
  TRANSFER_VALUE: { capability: "value.transfer", risk: "SENSITIVE" },
  SIGN_MESSAGE: { capability: "message.sign", risk: "SENSITIVE" },
  RECOVER_ACCOUNT: { capability: "account.recover", risk: "SENSITIVE" },
  CHANGE_PERMISSIONS: { capability: "permissions.change", risk: "SENSITIVE" },
};
export function classifyStatic(action: ActionProposalDraft): RiskLevel {
  const rule = Object.hasOwn(STATIC_RULES, action.type)
    ? STATIC_RULES[action.type]
    : undefined;
  if (!rule || rule.capability !== action.capability)
    throw new PolicyError("CAPABILITY_TYPE_MISMATCH");
  return rule.risk;
}
export function maximumRisk(...risks: RiskLevel[]): RiskLevel {
  return risks.includes("SENSITIVE")
    ? "SENSITIVE"
    : risks.includes("CONSEQUENTIAL")
      ? "CONSEQUENTIAL"
      : "ROUTINE";
}
