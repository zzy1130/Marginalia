/**
 * Electrobun postBuild hook — bundle Python backend into the .app
 * before it gets compressed into the self-extracting archive.
 */
import { cpSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

const buildEnv = process.env.ELECTROBUN_BUILD_ENV || "dev";
const appName = "Marginalia";
const appFileName = buildEnv === "stable" ? appName : `${appName}-${buildEnv}`;
const appPath = join("build", buildEnv, `${appFileName}.app`);
const pythonDest = join(appPath, "Contents", "Resources", "python");

console.log(`[postBuild] Bundling Python into ${appPath}...`);

mkdirSync(join(pythonDest, "core"), { recursive: true });

const coreFiles = ["server.py", "agent.py", "screen.py", "get_context.py"];
for (const file of coreFiles) {
  const src = join("core", file);
  if (existsSync(src)) {
    cpSync(src, join(pythonDest, "core", file));
  }
}

writeFileSync(join(pythonDest, "core", "__init__.py"), "");
cpSync("pyproject.toml", join(pythonDest, "pyproject.toml"));

if (existsSync(".python-version")) {
  cpSync(".python-version", join(pythonDest, ".python-version"));
}
if (existsSync(".env")) {
  cpSync(".env", join(pythonDest, ".env"));
}

console.log("[postBuild] Done — Python bundled.");
