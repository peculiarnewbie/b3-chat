import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const websiteDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(websiteDir, "../..");
const pkg = JSON.parse(readFileSync(path.join(websiteDir, "package.json"), "utf8"));

function gitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function buildVersion() {
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[:]/g, "");
  const commit = gitCommit();
  return {
    version: `${pkg.version ?? "0.0.0"}+deploy.${stamp}.${commit}`,
    commit,
    builtAt: new Date().toISOString(),
  };
}

const meta = buildVersion();
const env = {
  ...process.env,
  VITE_APP_VERSION: meta.version,
  VITE_GIT_SHA: meta.commit,
  VITE_BUILD_TIME: meta.builtAt,
};

console.log(`[deploy] version ${meta.version}`);
execSync("vp build", { cwd: websiteDir, stdio: "inherit", env });
execSync("vp exec wrangler deploy", { cwd: websiteDir, stdio: "inherit", env });
