import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  promptForConflictAction,
  promptForMissingCatalogAction,
  type ConflictAction,
  type MissingCatalogAction,
} from "./prompt";
import {
  compareParsedSpecs,
  formatSpec,
  parseSupportedSpec,
  type ParsedSpec,
  type SupportedPrefix,
  versionKey,
} from "./version";

type DependencySection = "dependencies" | "devDependencies";

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: WorkspaceConfig | string[];
  [key: string]: unknown;
}

interface WorkspaceConfig {
  packages?: string[];
  catalog?: Record<string, string>;
  [key: string]: unknown;
}

interface NormalizedWorkspaceConfig {
  catalog?: Record<string, string>;
  packages: string[];
  usesArrayWorkspaces: boolean;
}

interface ManifestFile {
  data: PackageJson;
  indent: string;
  isRoot: boolean;
  path: string;
  relativePath: string;
}

interface Occurrence {
  kind: "catalog" | "supported" | "unsupported";
  manifest: ManifestFile;
  name: string;
  section: DependencySection;
  spec: string;
}

interface VersionSource {
  label: string;
  parsed: ParsedSpec;
  spec: string;
}

interface MissingCatalogSpecResolution {
  resolvedFrom: string;
  spec: string;
}

interface ProcessingState {
  addedCatalog: Set<string>;
  changedManifestPaths: Set<string>;
  errors: string[];
  leftUnchanged: Set<string>;
  removedCatalogReferences: Set<string>;
  removedOccurrences: number;
  restoredCatalog: Set<string>;
  rewrittenOccurrences: number;
  skippedUnsupported: Set<string>;
  unresolvedConflicts: Set<string>;
  unresolvedMissingCatalog: Set<string>;
  updatedCatalog: Set<string>;
  warnings: string[];
}

export interface SyncOptions {
  dryRun: boolean;
  interactive: boolean;
  rootDir: string;
  yes: boolean;
}

export interface SyncResult {
  addedCatalog: string[];
  changedFiles: string[];
  dryRun: boolean;
  errors: string[];
  leftUnchanged: string[];
  removedCatalogReferences: string[];
  removedOccurrences: number;
  restoredCatalog: string[];
  rewrittenOccurrences: number;
  scannedManifests: number;
  skippedUnsupported: string[];
  unresolvedConflicts: string[];
  unresolvedMissingCatalog: string[];
  updatedCatalog: string[];
  warnings: string[];
  workspaceCount: number;
}

const DEPENDENCY_SECTIONS: DependencySection[] = ["dependencies", "devDependencies"];
const PREFIX_PRIORITY: Record<SupportedPrefix, number> = {
  "": 0,
  "~": 1,
  "^": 2,
};

export async function syncCatalog(options: SyncOptions): Promise<SyncResult> {
  const rootManifestPath = path.join(options.rootDir, "package.json");
  const rootManifest = await readManifest(rootManifestPath, options.rootDir, true);
  const workspaceConfig = getWorkspaceConfig(rootManifest);
  const workspaceManifests = await resolveWorkspaceManifests(
    options.rootDir,
    rootManifestPath,
    workspaceConfig,
  );
  const manifests = [rootManifest, ...workspaceManifests];
  const occurrencesByPackage = collectOccurrences(manifests);
  const state: ProcessingState = {
    addedCatalog: new Set<string>(),
    changedManifestPaths: new Set<string>(),
    errors: [],
    leftUnchanged: new Set<string>(),
    removedCatalogReferences: new Set<string>(),
    removedOccurrences: 0,
    restoredCatalog: new Set<string>(),
    rewrittenOccurrences: 0,
    skippedUnsupported: new Set<string>(),
    unresolvedConflicts: new Set<string>(),
    unresolvedMissingCatalog: new Set<string>(),
    updatedCatalog: new Set<string>(),
    warnings: [],
  };
  const startedWithArrayWorkspaces = workspaceConfig.usesArrayWorkspaces;

  for (const packageName of [...occurrencesByPackage.keys()].sort()) {
    const occurrences = occurrencesByPackage.get(packageName);

    if (!occurrences) {
      continue;
    }

    const manifestCount = new Set(occurrences.map((occurrence) => occurrence.manifest.path)).size;
    const hasCatalogUsage = occurrences.some((occurrence) => occurrence.kind === "catalog");

    if (!hasCatalogUsage && manifestCount < 2) {
      continue;
    }

    const supportedOccurrences = occurrences.filter((occurrence) => occurrence.kind === "supported");
    const catalogOccurrences = occurrences.filter((occurrence) => occurrence.kind === "catalog");
    const unsupportedOccurrences = occurrences.filter((occurrence) => occurrence.kind === "unsupported");
    const rootCatalog = getOrCreateCatalog(rootManifest, false);
    const currentCatalogSpec = rootCatalog?.[packageName];
    const parsedCatalogSpec =
      typeof currentCatalogSpec === "string" ? parseSupportedSpec(currentCatalogSpec) : null;

    if (unsupportedOccurrences.length > 0) {
      state.skippedUnsupported.add(
        `${packageName} (${unsupportedOccurrences.map((occurrence) => `${occurrence.spec} in ${formatOccurrence(occurrence)}`).join(", ")})`,
      );
      continue;
    }

    if (typeof currentCatalogSpec === "string" && !parsedCatalogSpec) {
      state.skippedUnsupported.add(`${packageName} (unsupported root catalog spec ${currentCatalogSpec})`);
      continue;
    }

    if (hasCatalogUsage && currentCatalogSpec === undefined) {
      await handleMissingCatalogEntry({
        catalogOccurrences,
        options,
        packageName,
        rootManifest,
        state,
        supportedOccurrences,
      });
      continue;
    }

    const versionSources = collectVersionSources(supportedOccurrences, currentCatalogSpec, parsedCatalogSpec);

    if (versionSources.length === 0) {
      continue;
    }

    const uniqueVersionKeys = [...new Set(versionSources.map((source) => versionKey(source.parsed.version)))];
    let targetSpec: string;

    if (uniqueVersionKeys.length === 1) {
      const onlyVersionKey = uniqueVersionKeys[0];

      if (!onlyVersionKey) {
        continue;
      }

      targetSpec = selectSpecForVersion(versionSources, onlyVersionKey, currentCatalogSpec);
    } else {
      const highestSource = selectHighestSource(versionSources);
      const suggestedSpec = selectSpecForVersion(
        versionSources,
        versionKey(highestSource.parsed.version),
        currentCatalogSpec,
      );
      let action: ConflictAction;

      if (options.yes) {
        action = "catalog";
      } else if (!options.interactive) {
        state.unresolvedConflicts.add(`${packageName} (${summarizeVersions(versionSources)})`);
        continue;
      } else {
        action = await promptForConflictAction({
          name: packageName,
          occurrences: occurrences.map(formatOccurrenceWithSpec),
          suggested: suggestedSpec,
          versions: summarizeVersionLines(versionSources),
        });
      }

      if (action === "leave") {
        state.leftUnchanged.add(packageName);
        continue;
      }

      targetSpec = suggestedSpec;
    }

    applyCatalogSpec({
      packageName,
      rootManifest,
      state,
      targetSpec,
      type: currentCatalogSpec === undefined ? "added" : currentCatalogSpec === targetSpec ? "unchanged" : "updated",
    });

    rewriteOccurrencesToCatalog(packageName, supportedOccurrences, state);
  }

  const changedManifests = manifests.filter((manifest) => state.changedManifestPaths.has(manifest.path));

  if (!options.dryRun) {
    for (const manifest of changedManifests) {
      await writeManifest(manifest);
    }
  }

  if (startedWithArrayWorkspaces && !Array.isArray(rootManifest.data.workspaces)) {
    state.warnings.push(
      options.dryRun
        ? "Would migrate root package.json workspaces from array form to object form to support workspaces.catalog."
        : "Migrated root package.json workspaces from array form to object form to support workspaces.catalog.",
    );
  }

  return {
    addedCatalog: [...state.addedCatalog].sort(),
    changedFiles: changedManifests.map((manifest) => manifest.relativePath).sort(),
    dryRun: options.dryRun,
    errors: state.errors,
    leftUnchanged: [...state.leftUnchanged].sort(),
    removedCatalogReferences: [...state.removedCatalogReferences].sort(),
    removedOccurrences: state.removedOccurrences,
    restoredCatalog: [...state.restoredCatalog].sort(),
    rewrittenOccurrences: state.rewrittenOccurrences,
    scannedManifests: manifests.length,
    skippedUnsupported: [...state.skippedUnsupported].sort(),
    unresolvedConflicts: [...state.unresolvedConflicts].sort(),
    unresolvedMissingCatalog: [...state.unresolvedMissingCatalog].sort(),
    updatedCatalog: [...state.updatedCatalog].sort(),
    warnings: state.warnings,
    workspaceCount: workspaceManifests.length,
  };
}

async function handleMissingCatalogEntry({
  catalogOccurrences,
  options,
  packageName,
  rootManifest,
  state,
  supportedOccurrences,
}: {
  catalogOccurrences: Occurrence[];
  options: SyncOptions;
  packageName: string;
  rootManifest: ManifestFile;
  state: ProcessingState;
  supportedOccurrences: Occurrence[];
}): Promise<void> {
  const resolution = await resolveMissingCatalogSpec(options.rootDir, packageName, supportedOccurrences);

  if (!resolution) {
    state.errors.push(
      `${packageName} uses catalog: but cataloger could not resolve a version from node_modules or existing manifest versions.`,
    );
    return;
  }

  let action: MissingCatalogAction;

  if (options.yes) {
    action = "restore";
  } else if (!options.interactive) {
    state.unresolvedMissingCatalog.add(
      `${packageName} (${catalogOccurrences.length} catalog ref${catalogOccurrences.length === 1 ? "" : "s"}, suggested ${resolution.spec})`,
    );
    return;
  } else {
    action = await promptForMissingCatalogAction({
      name: packageName,
      occurrences: catalogOccurrences.map(formatOccurrence),
      resolvedFrom: resolution.resolvedFrom,
      suggested: resolution.spec,
    });
  }

  if (action === "skip") {
    state.unresolvedMissingCatalog.add(
      `${packageName} (${catalogOccurrences.length} catalog ref${catalogOccurrences.length === 1 ? "" : "s"})`,
    );
    return;
  }

  if (action === "remove") {
    let removedCount = 0;

    for (const occurrence of catalogOccurrences) {
      if (removeDependencyReference(occurrence.manifest, occurrence.section, packageName)) {
        removedCount += 1;
        state.changedManifestPaths.add(occurrence.manifest.path);
      }
    }

    state.removedOccurrences += removedCount;

    if (removedCount > 0) {
      state.removedCatalogReferences.add(
        `${packageName} (${removedCount} catalog ref${removedCount === 1 ? "" : "s"} removed)`,
      );
    }

    return;
  }

  applyCatalogSpec({
    packageName,
    rootManifest,
    state,
    targetSpec: resolution.spec,
    type: "restored",
  });
  rewriteOccurrencesToCatalog(packageName, supportedOccurrences, state);
}

async function resolveMissingCatalogSpec(
  rootDir: string,
  packageName: string,
  supportedOccurrences: Occurrence[],
): Promise<MissingCatalogSpecResolution | undefined> {
  const installedVersion = await resolveInstalledPackageVersion(rootDir, packageName);

  if (installedVersion) {
    const parsedInstalledVersion = parseSupportedSpec(installedVersion);

    if (parsedInstalledVersion) {
      const preferredPrefix = selectPreferredPrefix(
        supportedOccurrences
          .map((occurrence) => parseSupportedSpec(occurrence.spec))
          .filter((value): value is ParsedSpec => value !== null),
      );

      return {
        resolvedFrom: `node_modules/${packageName}/package.json (${installedVersion})`,
        spec: formatSpec(preferredPrefix, parsedInstalledVersion.version),
      };
    }
  }

  if (supportedOccurrences.length === 0) {
    return undefined;
  }

  const versionSources = collectVersionSources(supportedOccurrences, undefined, null);
  const highestSource = selectHighestSource(versionSources);

  return {
    resolvedFrom: `workspace manifests (${summarizeVersions(versionSources)})`,
    spec: selectSpecForVersion(versionSources, versionKey(highestSource.parsed.version), undefined),
  };
}

async function resolveInstalledPackageVersion(rootDir: string, packageName: string): Promise<string | undefined> {
  const packageJsonPath = path.join(rootDir, "node_modules", ...packageName.split("/"), "package.json");

  try {
    const contents = await readFile(packageJsonPath, "utf8");
    const packageJson = JSON.parse(contents) as { version?: unknown };

    if (typeof packageJson.version !== "string") {
      return undefined;
    }

    return parseSupportedSpec(packageJson.version) ? packageJson.version : undefined;
  } catch {
    return undefined;
  }
}

function applyCatalogSpec({
  packageName,
  rootManifest,
  state,
  targetSpec,
  type,
}: {
  packageName: string;
  rootManifest: ManifestFile;
  state: ProcessingState;
  targetSpec: string;
  type: "added" | "restored" | "unchanged" | "updated";
}): void {
  const catalog = getOrCreateCatalog(rootManifest, true);

  if (!catalog) {
    throw new Error("Failed to initialize workspaces.catalog.");
  }

  const previousSpec = catalog[packageName];

  if (previousSpec === targetSpec) {
    return;
  }

  catalog[packageName] = targetSpec;
  state.changedManifestPaths.add(rootManifest.path);

  if (type === "restored") {
    state.restoredCatalog.add(`${packageName}@${targetSpec}`);
    return;
  }

  if (previousSpec === undefined) {
    state.addedCatalog.add(`${packageName}@${targetSpec}`);
    return;
  }

  state.updatedCatalog.add(`${packageName}: ${previousSpec} -> ${targetSpec}`);
}

function rewriteOccurrencesToCatalog(
  packageName: string,
  supportedOccurrences: Occurrence[],
  state: ProcessingState,
): void {
  for (const occurrence of supportedOccurrences) {
    const dependencies = occurrence.manifest.data[occurrence.section];

    if (!dependencies || dependencies[packageName] === "catalog:") {
      continue;
    }

    dependencies[packageName] = "catalog:";
    state.rewrittenOccurrences += 1;
    state.changedManifestPaths.add(occurrence.manifest.path);
  }
}

function removeDependencyReference(
  manifest: ManifestFile,
  section: DependencySection,
  packageName: string,
): boolean {
  const dependencies = manifest.data[section];

  if (!dependencies || !(packageName in dependencies)) {
    return false;
  }

  delete dependencies[packageName];

  if (Object.keys(dependencies).length === 0) {
    delete manifest.data[section];
  }

  return true;
}

function collectOccurrences(manifests: ManifestFile[]): Map<string, Occurrence[]> {
  const occurrencesByPackage = new Map<string, Occurrence[]>();

  for (const manifest of manifests) {
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = manifest.data[section];

      if (!dependencies || typeof dependencies !== "object") {
        continue;
      }

      for (const [name, spec] of Object.entries(dependencies)) {
        const occurrence: Occurrence = {
          kind: classifySpec(spec),
          manifest,
          name,
          section,
          spec,
        };
        const existing = occurrencesByPackage.get(name);

        if (existing) {
          existing.push(occurrence);
        } else {
          occurrencesByPackage.set(name, [occurrence]);
        }
      }
    }
  }

  return occurrencesByPackage;
}

function classifySpec(spec: string): Occurrence["kind"] {
  if (spec === "catalog:") {
    return "catalog";
  }

  if (spec.startsWith("catalog:")) {
    return "unsupported";
  }

  return parseSupportedSpec(spec) ? "supported" : "unsupported";
}

function collectVersionSources(
  supportedOccurrences: Occurrence[],
  currentCatalogSpec: string | undefined,
  parsedCatalogSpec: ParsedSpec | null,
): VersionSource[] {
  const sources = supportedOccurrences.map((occurrence) => ({
    label: formatOccurrence(occurrence),
    parsed: parseSupportedSpec(occurrence.spec) as ParsedSpec,
    spec: occurrence.spec,
  }));

  if (currentCatalogSpec && parsedCatalogSpec) {
    sources.push({
      label: "root workspaces.catalog",
      parsed: parsedCatalogSpec,
      spec: currentCatalogSpec,
    });
  }

  return sources;
}

function summarizeVersions(versionSources: VersionSource[]): string {
  const bySpec = new Map<string, number>();

  for (const source of versionSources) {
    bySpec.set(source.spec, (bySpec.get(source.spec) ?? 0) + 1);
  }

  return [...bySpec.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([spec, count]) => `${spec} x${count}`)
    .join(", ");
}

function summarizeVersionLines(versionSources: VersionSource[]): string[] {
  const bySpec = new Map<string, number>();

  for (const source of versionSources) {
    bySpec.set(source.spec, (bySpec.get(source.spec) ?? 0) + 1);
  }

  return [...bySpec.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([spec, count]) => `${spec} (${count} source${count === 1 ? "" : "s"})`);
}

function selectHighestSource(versionSources: VersionSource[]): VersionSource {
  const highestSource = [...versionSources].sort((left, right) => compareParsedSpecs(right.parsed, left.parsed))[0];

  if (!highestSource) {
    throw new Error("No version sources available.");
  }

  return highestSource;
}

function selectSpecForVersion(
  versionSources: VersionSource[],
  targetVersionKey: string,
  currentCatalogSpec: string | undefined,
): string {
  const matchingSources = versionSources.filter(
    (source) => versionKey(source.parsed.version) === targetVersionKey,
  );

  if (matchingSources.length === 0) {
    throw new Error(`No version sources found for ${targetVersionKey}.`);
  }

  if (currentCatalogSpec) {
    const parsedCurrent = parseSupportedSpec(currentCatalogSpec);

    if (parsedCurrent && versionKey(parsedCurrent.version) === targetVersionKey) {
      return currentCatalogSpec;
    }
  }

  const preferredPrefix = selectPreferredPrefix(matchingSources.map((source) => source.parsed));
  const targetVersion = matchingSources[0]?.parsed.version;

  if (!targetVersion) {
    throw new Error(`Missing parsed version for ${targetVersionKey}.`);
  }

  return formatSpec(preferredPrefix, targetVersion);
}

function selectPreferredPrefix(parsedSpecs: ParsedSpec[]): SupportedPrefix {
  if (parsedSpecs.length === 0) {
    return "";
  }

  const prefixCounts = new Map<SupportedPrefix, number>();

  for (const parsedSpec of parsedSpecs) {
    prefixCounts.set(parsedSpec.prefix, (prefixCounts.get(parsedSpec.prefix) ?? 0) + 1);
  }

  const preferredPrefix = [...prefixCounts.entries()].sort((left, right) => {
    if (left[1] !== right[1]) {
      return right[1] - left[1];
    }

    return PREFIX_PRIORITY[right[0]] - PREFIX_PRIORITY[left[0]];
  })[0]?.[0];

  return preferredPrefix ?? "";
}

function formatOccurrence(occurrence: Occurrence): string {
  return `${occurrence.manifest.relativePath} (${occurrence.section})`;
}

function formatOccurrenceWithSpec(occurrence: Occurrence): string {
  return `${occurrence.spec} in ${formatOccurrence(occurrence)}`;
}

function getWorkspaceConfig(rootManifest: ManifestFile): NormalizedWorkspaceConfig {
  const workspaces = rootManifest.data.workspaces;

  if (!workspaces) {
    throw new Error("Root package.json is missing workspaces.");
  }

  if (Array.isArray(workspaces)) {
    validateWorkspacePackages(workspaces);

    return {
      packages: [...workspaces],
      usesArrayWorkspaces: true,
    };
  }

  if (typeof workspaces !== "object") {
    throw new Error("Root package.json has an invalid workspaces configuration.");
  }

  validateWorkspacePackages(workspaces.packages);
  validateWorkspaceCatalog(workspaces.catalog);

  return {
    catalog: workspaces.catalog,
    packages: workspaces.packages,
    usesArrayWorkspaces: false,
  };
}

function validateWorkspacePackages(packages: unknown): asserts packages is string[] {
  if (!Array.isArray(packages) || packages.some((entry) => typeof entry !== "string")) {
    throw new Error(
      "Root package.json must define workspaces as an array of glob strings or workspaces.packages as an array of glob strings.",
    );
  }
}

function validateWorkspaceCatalog(catalog: unknown): asserts catalog is Record<string, string> | undefined {
  if (catalog !== undefined && (typeof catalog !== "object" || catalog === null || Array.isArray(catalog))) {
    throw new Error("Root package.json must define workspaces.catalog as an object when present.");
  }

  if (catalog !== undefined && Object.values(catalog).some((entry) => typeof entry !== "string")) {
    throw new Error("Root package.json workspaces.catalog values must all be strings.");
  }
}

async function resolveWorkspaceManifests(
  rootDir: string,
  rootManifestPath: string,
  workspaceConfig: NormalizedWorkspaceConfig,
): Promise<ManifestFile[]> {
  const manifestPaths = new Set<string>();

  for (const pattern of workspaceConfig.packages) {
    const manifestPattern = toManifestPattern(pattern);
    const glob = new Bun.Glob(manifestPattern);

    for await (const match of glob.scan({
      absolute: true,
      cwd: rootDir,
      onlyFiles: true,
    })) {
      const manifestPath = path.resolve(match);

      if (manifestPath === rootManifestPath || manifestPath.includes(`${path.sep}node_modules${path.sep}`)) {
        continue;
      }

      manifestPaths.add(manifestPath);
    }
  }

  return Promise.all(
    [...manifestPaths].sort().map((manifestPath) => readManifest(manifestPath, rootDir, false)),
  );
}

function getOrCreateCatalog(rootManifest: ManifestFile, create: boolean): Record<string, string> | undefined {
  const workspaces = rootManifest.data.workspaces;

  if (!workspaces) {
    throw new Error("Root package.json is missing workspaces.");
  }

  if (Array.isArray(workspaces)) {
    validateWorkspacePackages(workspaces);

    if (!create) {
      return undefined;
    }

    const migratedWorkspaces: WorkspaceConfig = {
      packages: [...workspaces],
      catalog: {},
    };

    rootManifest.data.workspaces = migratedWorkspaces;
    return migratedWorkspaces.catalog;
  }

  if (typeof workspaces !== "object") {
    throw new Error("Root package.json has an invalid workspaces configuration.");
  }

  validateWorkspacePackages(workspaces.packages);
  validateWorkspaceCatalog(workspaces.catalog);

  if (!workspaces.catalog) {
    if (!create) {
      return undefined;
    }

    workspaces.catalog = {};
  }

  return workspaces.catalog;
}

async function readManifest(
  manifestPath: string,
  rootDir: string,
  isRoot: boolean,
): Promise<ManifestFile> {
  const contents = await readFile(manifestPath, "utf8");

  return {
    data: JSON.parse(contents) as PackageJson,
    indent: detectIndent(contents),
    isRoot,
    path: manifestPath,
    relativePath: path.relative(rootDir, manifestPath) || "package.json",
  };
}

async function writeManifest(manifest: ManifestFile): Promise<void> {
  const serialized = `${JSON.stringify(manifest.data, null, manifest.indent)}\n`;
  await writeFile(manifest.path, serialized, "utf8");
}

function detectIndent(contents: string): string {
  const match = contents.match(/^[ \t]+(?=\"|\})/m);
  return match?.[0] ?? "  ";
}

function toManifestPattern(workspacePattern: string): string {
  const normalized = workspacePattern.replace(/\\/g, "/").replace(/\/$/, "");

  if (normalized.endsWith("package.json")) {
    return normalized;
  }

  return `${normalized}/package.json`;
}
