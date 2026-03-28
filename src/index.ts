#!/usr/bin/env bun

import { intro, note, outro } from "@clack/prompts";
import process from "node:process";
import type { SyncResult } from "./lib/catalog";
import { syncCatalog } from "./lib/catalog";
import { resolveRootDir } from "./lib/root";

interface CliOptions {
  command: "sync";
  dryRun: boolean;
  help: boolean;
  requestedRoot?: string;
  yes: boolean;
}

const HELP_TEXT = `cataloger

Usage:
  cataloger [sync] [--dry-run] [--yes] [--root <path>]

Options:
  --dry-run     Show planned changes without writing files
  --yes         Auto-accept recommended catalog changes
  --root        Start root detection from this directory or package.json path
  --help        Show this help message
`;

function parseArgs(argv: string[]): CliOptions {
  let command: "sync" = "sync";
  let dryRun = false;
  let yes = false;
  let requestedRoot: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "sync": {
        command = "sync";
        break;
      }
      case "--dry-run": {
        dryRun = true;
        break;
      }
      case "--yes": {
        yes = true;
        break;
      }
      case "--help":
      case "-h": {
        help = true;
        break;
      }
      case "--root": {
        const next = argv[index + 1];

        if (!next || next.startsWith("-")) {
          throw new Error("Missing value for --root.");
        }

        requestedRoot = next;
        index += 1;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${argument}`);
      }
    }
  }

  return {
    command,
    dryRun,
    help,
    requestedRoot,
    yes,
  };
}

function printList(title: string, values: string[]): void {
  if (values.length === 0) {
    return;
  }

  console.log(title);

  for (const value of values) {
    console.log(`- ${value}`);
  }
}

function printResult(result: SyncResult): void {
  const mode = result.dryRun ? "Dry run complete." : "Sync complete.";
  const changedFilesLabel = `${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"}`;
  const rewrittenLabel = `${result.rewrittenOccurrences} dependenc${result.rewrittenOccurrences === 1 ? "y" : "ies"}`;
  const removedLabel = `${result.removedOccurrences} catalog ref${result.removedOccurrences === 1 ? "" : "s"}`;

  console.log(mode);
  console.log(`Workspaces scanned: ${result.workspaceCount}`);
  console.log(`Manifest files scanned: ${result.scannedManifests}`);
  console.log(`Changed files: ${changedFilesLabel}`);
  console.log(`Catalog entries added: ${result.addedCatalog.length}`);
  console.log(`Catalog entries restored: ${result.restoredCatalog.length}`);
  console.log(`Catalog entries updated: ${result.updatedCatalog.length}`);
  console.log(`Dependencies rewritten to catalog: ${rewrittenLabel}`);
  console.log(`Catalog references removed: ${removedLabel}`);

  printList("Files changed:", result.changedFiles);
  printList("Catalog entries added:", result.addedCatalog);
  printList("Catalog entries restored:", result.restoredCatalog);
  printList("Catalog entries updated:", result.updatedCatalog);
  printList("Catalog references removed:", result.removedCatalogReferences);
  printList("Left unchanged:", result.leftUnchanged);
  printList("Skipped unsupported packages:", result.skippedUnsupported);
  printList("Unresolved version conflicts:", result.unresolvedConflicts);
  printList("Unresolved missing catalog entries:", result.unresolvedMissingCatalog);
  printList("Warnings:", result.warnings);
  printList("Errors:", result.errors);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  if (options.command !== "sync") {
    throw new Error(`Unsupported command: ${options.command}`);
  }

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

  if (interactive) {
    intro("cataloger");
  }

  const rootResolution = await resolveRootDir(options.requestedRoot);

  if (interactive) {
    note(
      [
        `Monorepo root: ${rootResolution.rootDir}`,
        `Mode: ${options.dryRun ? "dry run" : "write changes"}`,
        `Conflict handling: ${options.yes ? "auto-accept recommended changes" : "interactive"}`,
      ].join("\n"),
      "Using configuration",
    );
  }

  const result = await syncCatalog({
    dryRun: options.dryRun,
    interactive,
    rootDir: rootResolution.rootDir,
    yes: options.yes,
  });

  printResult(result);

  if (interactive) {
    outro(
      result.errors.length > 0 ||
        result.unresolvedConflicts.length > 0 ||
        result.unresolvedMissingCatalog.length > 0
        ? "cataloger finished with follow-ups."
        : "cataloger finished successfully.",
    );
  }

  if (
    result.errors.length > 0 ||
    result.unresolvedConflicts.length > 0 ||
    result.unresolvedMissingCatalog.length > 0
  ) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`cataloger failed: ${message}`);
  process.exit(1);
});
