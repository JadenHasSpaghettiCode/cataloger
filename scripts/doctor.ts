#!/usr/bin/env bun

import { access, lstat, readlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { intro, note, outro } from "@clack/prompts";

const repoRoot = path.resolve(import.meta.dir, "..");
const binaryName = process.platform === "win32" ? "cataloger.exe" : "cataloger";
const localBinary = path.join(repoRoot, "dist", binaryName);

async function main(): Promise<void> {
  intro("cataloger doctor");

  const binDir = await getBunGlobalBin();
  const installPath = path.join(binDir, binaryName);
  const onPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((entry) => path.resolve(entry) === path.resolve(binDir));

  const localBinaryExists = await exists(localBinary);
  const installedBinaryExists = await exists(installPath);
  const installedBinaryKind = installedBinaryExists ? await describeInstall(installPath) : "missing";

  note(
    [
      `Bun version: ${Bun.version}`,
      `Global bin: ${binDir}`,
      `Global bin on PATH: ${onPath ? "yes" : "no"}`,
      `Local compiled binary: ${localBinaryExists ? localBinary : "missing"}`,
      `Installed binary: ${installedBinaryExists ? installPath : "missing"}`,
      `Install type: ${installedBinaryKind}`,
    ].join("\n"),
    "cataloger environment",
  );

  outro(localBinaryExists && installedBinaryExists ? "Doctor checks passed." : "Doctor found setup follow-ups.");
}

async function describeInstall(targetPath: string): Promise<string> {
  const stats = await lstat(targetPath);

  if (stats.isSymbolicLink()) {
    const target = await readlink(targetPath);
    return `symlink -> ${target}`;
  }

  return "copied executable";
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
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
  console.error(`doctor failed: ${message}`);
  process.exit(1);
});
