export type SupportedPrefix = "" | "^" | "~";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

export interface ParsedSpec {
  original: string;
  prefix: SupportedPrefix;
  version: SemVer;
}

const SPEC_PATTERN = /^([~^]?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSupportedSpec(spec: string): ParsedSpec | null {
  const match = SPEC_PATTERN.exec(spec);

  if (!match) {
    return null;
  }

  const [, rawPrefix, major, minor, patch, prerelease] = match;

  return {
    original: spec,
    prefix: (rawPrefix ?? "") as SupportedPrefix,
    version: {
      major: Number(major),
      minor: Number(minor),
      patch: Number(patch),
      prerelease: parsePrerelease(prerelease),
    },
  };
}

export function compareParsedSpecs(left: ParsedSpec, right: ParsedSpec): number {
  return compareSemVer(left.version, right.version);
}

export function formatSpec(prefix: SupportedPrefix, version: SemVer): string {
  return `${prefix}${formatVersion(version)}`;
}

export function formatVersion(version: SemVer): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;

  if (version.prerelease.length === 0) {
    return base;
  }

  const prerelease = version.prerelease.map(String).join(".");
  return `${base}-${prerelease}`;
}

export function versionKey(version: SemVer): string {
  return formatVersion(version);
}

function compareSemVer(left: SemVer, right: SemVer): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }

  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }

  if (left.patch !== right.patch) {
    return left.patch - right.patch;
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

function comparePrerelease(left: Array<number | string>, right: Array<number | string>): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }

  if (left.length === 0) {
    return 1;
  }

  if (right.length === 0) {
    return -1;
  }

  const maxLength = Math.max(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];

    if (leftPart === undefined) {
      return -1;
    }

    if (rightPart === undefined) {
      return 1;
    }

    if (leftPart === rightPart) {
      continue;
    }

    if (typeof leftPart === "number" && typeof rightPart === "number") {
      return leftPart - rightPart;
    }

    if (typeof leftPart === "number") {
      return -1;
    }

    if (typeof rightPart === "number") {
      return 1;
    }

    return leftPart.localeCompare(rightPart);
  }

  return 0;
}

function parsePrerelease(prerelease: string | undefined): Array<number | string> {
  if (!prerelease) {
    return [];
  }

  return prerelease.split(".").map((part) => {
    if (/^\d+$/.test(part)) {
      return Number(part);
    }

    return part;
  });
}
