import { AsyncLocalStorage } from "node:async_hooks";
import type { UsageContext } from "@humanos/database";
import type { ModelUsageAttempt } from "@humanos/models";
export function createUsageContext(save: (context: UsageContext, event: ModelUsageAttempt) => Promise<void>) {
  const storage = new AsyncLocalStorage<UsageContext>();
  return {
    run<T>(context: UsageContext, work: () => Promise<T>): Promise<T> { return storage.run(context, work); },
    async onAttempt(event: ModelUsageAttempt) {
      const context = storage.getStore();
      if (!context) throw new Error("USAGE_CONTEXT_REQUIRED");
      await save(context, event);
    },
  };
}
