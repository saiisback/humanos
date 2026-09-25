import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter(
    (p) =>
      !p.startsWith("packages/contracts/lib/") && !p.endsWith("pnpm-lock.yaml"),
  );
const findings = [];
for (const path of files) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  if (
    /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/.test(text) ||
    /\bnpm_[A-Za-z0-9]{32,}\b/.test(text)
  )
    findings.push(path + ": possible credential");
  if (
    /\.(ts|tsx|sol)$/.test(path) &&
    !path.includes("/test/") &&
    !path.startsWith("tests/") &&
    /(?:throw new Error\(['"]not implemented|TDD stub|revert NotImplemented\()/.test(
      text,
    )
  )
    findings.push(path + ": unfinished implementation");
}
if (findings.length) {
  console.error(findings.join("\n"));
  process.exit(1);
}
console.log(
  `Scanned ${files.length} repository files (including untracked, excluding ignored): no recognized credentials or implementation stubs.`,
);
