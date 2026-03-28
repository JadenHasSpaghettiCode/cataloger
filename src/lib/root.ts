import { readFile } from "node:fs/promises";
import path from "node:path";

interface PackageJson {
  workspaces?: unknown;
}

export interface RootResolution {
  requestedPath?: string;
  rootDir: string;
}

export async function resolveRootDir(requestedPath?: string): Promise<RootResolution> {
  const normalizedStart = normalizeStartPath(requestedPath ?? process.cwd());
  const rootDir = await findWorkspaceRoot(normalizedStart);

  if (!rootDir) {
    throw new Error(
      `Could not find a Bun monorepo root from ${normalizedStart}. Run cataloger from your monorepo root or pass --root.`,
    );
  }

  return {
    requestedPath,
    rootDir,
  };
}

function normalizeStartPath(inputPath: string): string {
  const resolvedPath = path.resolve(inputPath);

  if (path.basename(resolvedPath) === "package.json") {
    return path.dirname(resolvedPath);
  }

  return resolvedPath;
}

async function findWorkspaceRoot(startDir: string): Promise<string | undefined> {
  let currentDir = startDir;

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    const packageJson = await readPackageJson(packageJsonPath);

    if (packageJson && hasWorkspaceConfig(packageJson)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson | undefined> {
  try {
    const contents = await readFile(packageJsonPath, "utf8");
    return JSON.parse(contents) as PackageJson;
  } catch {
    return undefined;
  }
}

function hasWorkspaceConfig(packageJson: PackageJson): boolean {
  const workspaces = packageJson.workspaces;

  if (Array.isArray(workspaces)) {
    return workspaces.every((entry) => typeof entry === "string");
  }

  if (!workspaces || typeof workspaces !== "object") {
    return false;
  }

  const packages = (workspaces as { packages?: unknown }).packages;
  return Array.isArray(packages) && packages.every((entry) => typeof entry === "string");
}
