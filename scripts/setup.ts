#!/usr/bin/env bun

import { copyFile, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { intro, log, note, outro, spinner } from "@clack/prompts";

const repoRoot = path.resolve(import.meta.dir, "..");
const binaryName = process.platform === "win32" ? "cataloger.exe" : "cataloger";
const outfile = path.join(repoRoot, "dist", binaryName);

async function main(): Promise<void> {
  intro("cataloger setup");

  const buildSpinner = spinner();
  buildSpinner.start("Building standalone cataloger binary");
  await mkdir(path.dirname(outfile), { recursive: true });

  const buildResult = await Bun.build({
    bytecode: true,
    compile: {
      outfile,
    },
    entrypoints: [path.join(repoRoot, "src", "index.ts")],
    minify: true,
  });

  if (!buildResult.success) {
    buildSpinner.stop("Build failed");
    for (const logEntry of buildResult.logs) {
      log.error(logEntry.message);
    }
    process.exit(1);
  }

  buildSpinner.stop(`Built ${outfile}`);

  const binDir = await getBunGlobalBin();
  const installPath = path.join(binDir, binaryName);
  const linkSpinner = spinner();
  linkSpinner.start(`Installing cataloger into ${binDir}`);

  await mkdir(binDir, { recursive: true });
  await rm(installPath, { force: true, recursive: true });

  let installMethod = "symlink";

  try {
    await symlink(outfile, installPath);
  } catch {
    await copyFile(outfile, installPath);
    installMethod = "copy";
  }

  linkSpinner.stop(`Installed cataloger via ${installMethod}`);

  const pathContainsBinDir = (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((entry) => path.resolve(entry) === path.resolve(binDir));

  note(
    [`Binary: ${outfile}`, `Installed at: ${installPath}`, `Method: ${installMethod}`].join("\n"),
    "Installation details",
  );

  if (!pathContainsBinDir) {
    log.warn(`Your PATH does not currently include ${binDir}. Add it to use cataloger globally.`);
  }

  outro("Setup complete. Run `cataloger sync` from a Bun monorepo root.");
}

async function getBunGlobalBin(): Promise<string> {
  const proc = Bun.spawnSync(["bun", "pm", "bin", "-g"], {
    cwd: repoRoot,
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(proc.stderr).trim() || "Failed to resolve Bun global bin directory.");
  }

  return new TextDecoder().decode(proc.stdout).trim();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`setup failed: ${message}`);
  process.exit(1);
});
