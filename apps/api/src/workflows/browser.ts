import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { hashCanonical, type ErrorClass } from "@humanos/schemas";
import { normalizeSubmission, publicDestination, type BrowserSubmission } from "./confirmations.js";

/**
 * Browser fallback. Everything a page can influence is data: destinations, fields,
 * selectors and success checks come only from audited recipes in source. There is no
 * path for model output or page content to supply a selector, script or URL.
 */

export class BrowserExecutionError extends Error {
  constructor(readonly errorClass: ErrorClass, message: string = errorClass) { super(message); }
}

// ---------------------------------------------------------------------------
// Network policy

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(network, prefix, "ipv6");

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  if (/^::ffff:/i.test(address)) return false;
  return !blocked.check(address, "ipv6");
}

export interface BrowserNetworkPolicy {
  resolve(host: string): Promise<string[]>;
  isPublicAddress(address: string): boolean;
  /** Test fixtures only; production recipes must be HTTPS. */
  allowHttp: boolean;
}
export const strictNetworkPolicy: BrowserNetworkPolicy = Object.freeze({
  resolve: async (host: string) => (await lookup(host, { all: true, verbatim: true })).map(entry => entry.address),
  isPublicAddress,
  allowHttp: false,
});

/**
 * Resolve every allowed host once, require public addresses, and pin Chromium's resolver
 * to them. Unlisted hostnames resolve to nothing, which also defeats DNS rebinding.
 */
export async function hostResolverRules(recipe: BrowserRecipe, policy: BrowserNetworkPolicy): Promise<string> {
  const rules: string[] = [];
  for (const host of new Set(recipe.allowedOrigins.map(origin => new URL(origin).hostname))) {
    let addresses: string[];
    try { addresses = await policy.resolve(host); } catch { throw new BrowserExecutionError("TRANSIENT", "UNSAFE_DESTINATION"); }
    if (!addresses.length || !addresses.every(address => policy.isPublicAddress(address)))
      throw new BrowserExecutionError("VALIDATION", "UNSAFE_DESTINATION");
    const pinned = addresses[0]!;
    rules.push(`MAP ${host} ${isIP(pinned) === 6 ? `[${pinned}]` : pinned}`);
  }
  rules.push("MAP * ~NOTFOUND");
  return rules.join(",");
}

// ---------------------------------------------------------------------------
// Audited recipes

export interface BrowserRecipeField {
  readonly name: string;
  readonly label: string;
  readonly selector: string;
  readonly maxLength: number;
  readonly pattern?: RegExp;
}
export interface BrowserRecipe {
  readonly id: string;
  readonly label: string;
  /** Scheme + host (+ port); the only page the recipe opens is origin + entryPath. */
  readonly origin: string;
  /** Every origin the page may load from; all other requests are aborted. */
  readonly allowedOrigins: readonly string[];
  readonly entryPath: string;
  /**
   * Exact audited paths (GET/HEAD, no query string) the page may load while the entry page
   * loads, in addition to entryPath. After load, the page is frozen: no request at all.
   */
  readonly readResources: readonly string[];
  readonly fields: readonly BrowserRecipeField[];
  /** Price/value shown on the page, bound into the confirmation. */
  readonly value?: { readonly selector: string; readonly currency: string };
  /** Page state that is material to the decision (time slot, availability, terms). */
  readonly materialSelectors: readonly string[];
  readonly submitSelector: string;
  /**
   * The single state-changing request the submit click may send, only after approval, and only
   * with exactly the confirmed field values as its body. Recipe field names are the form
   * parameter names; forms with any other parameters (e.g. hidden tokens) are unsupported.
   */
  readonly submitRequest: { readonly method: "POST" | "PUT" | "PATCH"; readonly path: string; readonly contentType: "application/x-www-form-urlencoded" };
  readonly success: { readonly pathPrefix: string; readonly referenceSelector: string; readonly referencePattern: RegExp };
}

// A deliberately small CSS subset: ids, classes, element names, attribute equality,
// descendant/child combinators. No selector engines, chaining, pseudo-classes or functions.
const selectorPattern = /^[A-Za-z0-9#._\-[\]="' >]{1,200}$/;
function assertSelector(selector: string): void {
  if (!selectorPattern.test(selector) || /^[a-z-]+=/i.test(selector) || selector.includes(">>") || /script/i.test(selector))
    throw new Error("INVALID_SELECTOR");
}
function assertOrigin(raw: string, allowHttp: boolean): string {
  const url = new URL(raw);
  if (url.origin !== raw || (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))) throw new Error("INVALID_ORIGIN");
  publicDestination(raw);
  return url.origin;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export class BrowserRecipeRegistry {
  private readonly recipes = new Map<string, BrowserRecipe>();
  constructor(private readonly options: { allowHttp?: boolean } = {}) {}
  register(recipe: BrowserRecipe): void {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(recipe.id) || !recipe.label.trim() || recipe.label.length > 128) throw new Error("INVALID_RECIPE");
    if (this.recipes.has(recipe.id)) throw new Error("DUPLICATE_RECIPE");
    const allowHttp = this.options.allowHttp ?? false;
    const origin = assertOrigin(recipe.origin, allowHttp);
    const allowed = recipe.allowedOrigins.map(item => assertOrigin(item, allowHttp));
    if (!allowed.includes(origin) || allowed.length > 8) throw new Error("INVALID_ORIGIN");
    if (!/^\/[A-Za-z0-9/_\-.]{0,200}$/.test(recipe.entryPath) || recipe.entryPath.includes("//")) throw new Error("INVALID_ENTRY_PATH");
    if (!/^\/[A-Za-z0-9/_\-.]{0,200}$/.test(recipe.success.pathPrefix)) throw new Error("INVALID_SUCCESS_CHECK");
    if (!["POST", "PUT", "PATCH"].includes(recipe.submitRequest?.method) || !/^\/[A-Za-z0-9/_\-.]{0,200}$/.test(recipe.submitRequest.path) ||
        recipe.submitRequest.contentType !== "application/x-www-form-urlencoded") throw new Error("INVALID_SUBMIT_REQUEST");
    if (!Array.isArray(recipe.readResources) || recipe.readResources.length > 32 ||
        recipe.readResources.some(path => typeof path !== "string" || !/^\/[A-Za-z0-9/_\-.]{0,200}$/.test(path) || path.includes("//"))) throw new Error("INVALID_READ_RESOURCES");
    // Stateful (g/y) patterns would make test() depend on shared lastIndex.
    for (const pattern of [recipe.success.referencePattern, ...recipe.fields.flatMap(field => field.pattern ? [field.pattern] : [])])
      if (!(pattern instanceof RegExp) || pattern.global || pattern.sticky) throw new Error("INVALID_PATTERN");
    if (!recipe.fields.length || recipe.fields.length > 32 || new Set(recipe.fields.map(f => f.name)).size !== recipe.fields.length) throw new Error("INVALID_FIELDS");
    for (const field of recipe.fields) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(field.name) || !field.label.trim() || !Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 2000) throw new Error("INVALID_FIELDS");
      assertSelector(field.selector);
    }
    if (recipe.value) { assertSelector(recipe.value.selector); if (!/^[A-Z]{3}$/.test(recipe.value.currency)) throw new Error("INVALID_VALUE"); }
    if (recipe.materialSelectors.length > 16) throw new Error("INVALID_RECIPE");
    recipe.materialSelectors.forEach(assertSelector);
    assertSelector(recipe.submitSelector);
    assertSelector(recipe.success.referenceSelector);
    this.recipes.set(recipe.id, deepFreeze(structuredCloneRecipe(recipe)));
  }
  get(id: string): BrowserRecipe | null { return this.recipes.get(id) ?? null; }
  list(): readonly BrowserRecipe[] { return [...this.recipes.values()]; }
}
const clonePattern = (pattern: RegExp) => new RegExp(pattern.source, pattern.flags);
function structuredCloneRecipe(recipe: BrowserRecipe): BrowserRecipe {
  return {
    ...recipe,
    allowedOrigins: [...recipe.allowedOrigins],
    readResources: [...recipe.readResources],
    fields: recipe.fields.map(field => ({ ...field, ...(field.pattern ? { pattern: clonePattern(field.pattern) } : {}) })),
    ...(recipe.value ? { value: { ...recipe.value } } : {}),
    materialSelectors: [...recipe.materialSelectors],
    submitRequest: { ...recipe.submitRequest },
    success: { ...recipe.success, referencePattern: clonePattern(recipe.success.referencePattern) },
  };
}

/**
 * Production recipes. Intentionally empty: adding a real site requires the user's explicit
 * choice of site, review of its fields/terms, and a signed-in HumanOS browser profile.
 * Until then every browser.submit step pauses without opening a page.
 */
export function createAuditedRecipeRegistry(): BrowserRecipeRegistry {
  return new BrowserRecipeRegistry();
}

/**
 * True only for exactly the confirmed form: same media type (no parameters), and the body
 * decodes to exactly the confirmed field names and values, each once, nothing else.
 */
export function exactFormBody(contentType: string | undefined, body: string | null, expectedType: "application/x-www-form-urlencoded", fields: Readonly<Record<string, string>>): boolean {
  if (contentType?.trim().toLowerCase() !== expectedType || body === null) return false;
  const params = [...new URLSearchParams(body)];
  const names = Object.keys(fields);
  if (params.length !== names.length || new Set(params.map(([name]) => name)).size !== params.length) return false;
  return params.every(([name, value]) => Object.hasOwn(fields, name) && fields[name] === value);
}

// ---------------------------------------------------------------------------
// Driver port and the concrete local Chromium driver

/** The only page operations the executor can perform. Selectors come from recipes. */
export interface BrowserPage {
  goto(url: string): Promise<void>;
  url(): string;
  fill(selector: string, value: string): Promise<void>;
  inputValue(selector: string): Promise<string>;
  text(selector: string): Promise<string>;
  /**
   * The only operation that may change remote state. Before it, only the audited entry load
   * reaches the network; during it, exactly one request carrying exactly `fields` is let through.
   */
  submitOnce(selector: string, request: BrowserRecipe["submitRequest"], fields: Readonly<Record<string, string>>): Promise<void>;
  close(): Promise<void>;
}
export interface BrowserDriver {
  open(recipe: BrowserRecipe): Promise<BrowserPage>;
}

export interface PlaywrightDriverOptions {
  /**
   * Dedicated HumanOS profile directory. The user signs in to audited sites there;
   * it is never the user's everyday browser profile, and cookies are never exported.
   */
  profileDir?: string;
  headless?: boolean;
  policy?: BrowserNetworkPolicy;
  timeoutMs?: number;
}
/** Local, opt-in Chromium driver (playwright-core). One isolated browser per step. */
export function createPlaywrightDriver(options: PlaywrightDriverOptions = {}): BrowserDriver {
  const policy = options.policy ?? strictNetworkPolicy;
  const timeout = options.timeoutMs ?? 20000;
  return {
    async open(recipe) {
      const { chromium } = await import("playwright-core");
      const allowed = new Set(recipe.allowedOrigins);
      const args = [`--host-resolver-rules=${await hostResolverRules(recipe, policy)}`, "--no-proxy-server", "--disable-quic"];
      const common = { args, headless: options.headless ?? true, serviceWorkers: "block" as const, acceptDownloads: false };
      const browser = options.profileDir ? null : await chromium.launch({ args, headless: common.headless });
      const context = options.profileDir
        ? await chromium.launchPersistentContext(options.profileDir, common)
        : await browser!.newContext({ serviceWorkers: "block", acceptDownloads: false });
      const closeAll = async () => { await context.close().catch(() => {}); await browser?.close().catch(() => {}); };
      try {
        context.setDefaultTimeout(timeout);
        // Fail-closed, phased network gate covering every request (navigations, redirect hops,
        // subresources, fetch/XHR, beacons, images, form posts):
        //   loading   -> only GET/HEAD of the entry path or audited read paths, no query string
        //   frozen    -> nothing (capture and fill happen here, so typed data cannot leave)
        //   armed     -> exactly one request bound to the confirmed method/path/type/body
        //   submitted -> only GET of the audited success path (and audited read paths)
        const reads = new Set([recipe.entryPath, ...recipe.readResources]);
        let phase: "loading" | "frozen" | "armed" | "submitted" = "frozen";
        let bound: { request: BrowserRecipe["submitRequest"]; fields: Readonly<Record<string, string>>; sent(): void } | null = null;
        let tampered = false;
        await context.route("**/*", route => {
          const request = route.request();
          let url: URL;
          try { url = new URL(request.url()); } catch { return route.abort("blockedbyclient"); }
          if (!allowed.has(url.origin)) return route.abort("blockedbyclient");
          const method = request.method().toUpperCase();
          const read = (method === "GET" || method === "HEAD") && url.origin === recipe.origin;
          if (phase === "loading" && read && !url.search && reads.has(url.pathname)) return route.continue();
          if (phase === "submitted" && read && (url.pathname.startsWith(recipe.success.pathPrefix) || (!url.search && reads.has(url.pathname)))) return route.continue();
          if (phase === "armed" && bound && method === bound.request.method && url.origin === recipe.origin &&
              url.pathname === bound.request.path) {
            if (!url.search && exactFormBody(request.headers()["content-type"], request.postData(), bound.request.contentType, bound.fields)) {
              phase = "submitted"; // one-shot
              bound.sent();
              return route.continue();
            }
            tampered = true; // a different payload to the audited endpoint: never sent
          }
          return route.abort("blockedbyclient");
        });
        // WebSockets bypass HTTP routing; never connect them to the site.
        await context.routeWebSocket(/.*/, socket => { void socket.close(); });
        const page = context.pages()[0] ?? await context.newPage();
        // Popups are never followed.
        context.on("page", extra => { if (extra !== page) void extra.close().catch(() => {}); });
        const assertAllowed = () => {
          if (!allowed.has(new URL(page.url()).origin)) throw new BrowserExecutionError("VALIDATION", "UNSAFE_REDIRECT");
        };
        return {
          async goto(url) {
            if (!allowed.has(new URL(url).origin)) throw new BrowserExecutionError("VALIDATION", "UNSAFE_DESTINATION");
            phase = "loading";
            try { await page.goto(url, { waitUntil: "load" }); }
            finally { phase = "frozen"; }
            assertAllowed();
          },
          url: () => page.url(),
          fill: async (selector, value) => { await page.locator(selector).fill(value); },
          inputValue: selector => page.locator(selector).inputValue(),
          text: async selector => (await page.locator(selector).innerText()).trim(),
          async submitOnce(selector, request, fields) {
            let sent!: () => void;
            const released = new Promise<void>(resolve => { sent = resolve; });
            bound = { request, fields: { ...fields }, sent };
            phase = "armed";
            try {
              await page.locator(selector).click();
              await Promise.race([released, new Promise((_, reject) => setTimeout(() => reject(new Error("SUBMISSION_NOT_SENT")), timeout))]);
              await page.waitForLoadState("domcontentloaded");
            } finally {
              if (phase === "armed") phase = "frozen";
              bound = null;
            }
            // Any competing payload means the page is hostile; never report this as success.
            if (tampered) throw new BrowserExecutionError("UNKNOWN_OUTCOME", "SUBMISSION_TAMPERED");
            assertAllowed();
          },
          close: closeAll,
        };
      } catch (error) {
        await closeAll();
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Executor: prepare (navigate + fill + read back) and a single approved submit

export interface BrowserReceipt {
  finalUrl: string;
  successEvidence: string;
  providerReference: string;
}
export interface BrowserExecutor {
  prepare(input: { recipeId: string; fields: Record<string, string> }): Promise<BrowserSubmission>;
  /** `approve` must atomically claim the confirmed submission; it runs before the only click. */
  submit(input: { recipeId: string; fields: Record<string, string>; approve(submission: BrowserSubmission): Promise<void> }): Promise<BrowserReceipt>;
}

const normalizeText = (value: string) => value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
function parseAmount(text: string): string {
  const match = /(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,18})?/.exec(text);
  if (!match) throw new BrowserExecutionError("VALIDATION", "VALUE_UNREADABLE");
  return `${match[1]!.replaceAll(",", "")}${match[2] ?? ""}`;
}
function validateFields(recipe: BrowserRecipe, fields: Record<string, string>): void {
  for (const name of Object.keys(fields))
    if (!recipe.fields.some(field => field.name === name)) throw new BrowserExecutionError("VALIDATION", "FIELD_NOT_ALLOWED");
  for (const field of recipe.fields) {
    const value = fields[field.name];
    if (typeof value !== "string" || !value.trim()) throw new BrowserExecutionError("VALIDATION", "FIELD_REQUIRED");
    if (value.length > field.maxLength || (field.pattern && !field.pattern.test(value))) throw new BrowserExecutionError("VALIDATION", "FIELD_INVALID");
  }
}

export function createBrowserExecutor(deps: { recipes: BrowserRecipeRegistry; driver: BrowserDriver }): BrowserExecutor {
  function recipeFor(id: string): BrowserRecipe {
    const recipe = deps.recipes.get(id);
    if (!recipe) throw new BrowserExecutionError("VALIDATION", "RECIPE_NOT_FOUND");
    return recipe;
  }
  async function capture(page: BrowserPage, recipe: BrowserRecipe, fields: Record<string, string>): Promise<BrowserSubmission> {
    const destination = `${recipe.origin}${recipe.entryPath}`;
    await page.goto(destination);
    if (new URL(page.url()).origin !== recipe.origin) throw new BrowserExecutionError("VALIDATION", "UNSAFE_REDIRECT");
    const filled: Record<string, string> = {};
    for (const field of recipe.fields) {
      await page.fill(field.selector, fields[field.name]!);
      const readBack = await page.inputValue(field.selector);
      // The page must hold exactly what will be shown for confirmation.
      if (readBack !== fields[field.name]) throw new BrowserExecutionError("VALIDATION", "FIELD_NOT_ACCEPTED");
      filled[field.name] = readBack;
    }
    const material: string[] = [];
    for (const selector of recipe.materialSelectors) material.push(normalizeText(await page.text(selector)));
    const value = recipe.value ? { amount: parseAmount(await page.text(recipe.value.selector)), currency: recipe.value.currency } : null;
    const current = new URL(page.url());
    return normalizeSubmission({
      destination, fields: filled, attachments: [], value,
      pageFingerprint: hashCanonical({ recipeId: recipe.id, origin: current.origin, path: current.pathname, material, value }),
    });
  }
  return {
    async prepare({ recipeId, fields }) {
      const recipe = recipeFor(recipeId);
      validateFields(recipe, fields);
      const page = await deps.driver.open(recipe);
      try { return await capture(page, recipe, fields); }
      finally { await page.close(); }
    },
    async submit({ recipeId, fields, approve }) {
      const recipe = recipeFor(recipeId);
      validateFields(recipe, fields);
      const page = await deps.driver.open(recipe);
      try {
        const submission = await capture(page, recipe, fields);
        await approve(submission);
        // From the click onward the site may have accepted the action: never report
        // anything but verified success, and never retry blindly.
        try {
          await page.submitOnce(recipe.submitSelector, recipe.submitRequest, submission.fields);
          const finalUrl = new URL(page.url());
          if (finalUrl.origin !== recipe.origin || !finalUrl.pathname.startsWith(recipe.success.pathPrefix))
            throw new Error("SUCCESS_NOT_OBSERVED");
          const reference = normalizeText(await page.text(recipe.success.referenceSelector));
          if (!recipe.success.referencePattern.test(reference)) throw new Error("SUCCESS_NOT_OBSERVED");
          finalUrl.search = ""; finalUrl.hash = "";
          return { finalUrl: finalUrl.href, successEvidence: `${recipe.label}: reference ${reference}`, providerReference: reference };
        } catch {
          throw new BrowserExecutionError("UNKNOWN_OUTCOME", "BROWSER_OUTCOME_UNKNOWN");
        }
      } finally {
        await page.close();
      }
    },
  };
}
