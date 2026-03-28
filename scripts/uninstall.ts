#!/usr/bin/env bun

import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { intro, outro } from "@clack/prompts";

const repoRoot = path.resolve(import.meta.dir, "..");
const binaryName = process.platform === "win32" ? "cataloger.exe" : "cataloger";

async function main(): Promise<void> {
  intro("cataloger uninstall");
  const binDir = await getBunGlobalBin();
  const installPath = path.join(binDir, binaryName);

  await rm(installPath, { force: true, recursive: true });
  outro(`Removed ${installPath}`);
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
  console.error(`uninstall failed: ${message}`);
  process.exit(1);
});
