export class PolicyError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PolicyError";
  }
}
