import { cancel, isCancel, note, select } from "@clack/prompts";

interface ConflictPromptDetails {
  name: string;
  versions: string[];
  occurrences: string[];
  suggested: string;
}

interface MissingCatalogPromptDetails {
  name: string;
  occurrences: string[];
  resolvedFrom: string;
  suggested: string;
}

export type ConflictAction = "catalog" | "leave";
export type MissingCatalogAction = "remove" | "restore" | "skip";

export async function promptForConflictAction(details: ConflictPromptDetails): Promise<ConflictAction> {
  note(details.versions.join("\n"), `Version conflict: ${details.name}`);
  note(details.occurrences.join("\n"), "Seen in");

  const response = await select({
    message: `How should cataloger handle ${details.name}?`,
    options: [
      {
        label: `Add to catalog using ${details.suggested}`,
        hint: "recommended",
        value: "catalog",
      },
      {
        label: "Leave versions unchanged",
        hint: "do not convert this package to catalog",
        value: "leave",
      },
    ],
  });

  if (isCancel(response)) {
    cancel("Cancelled selection. Leaving versions unchanged for this package.");
    return "leave";
  }

  return response as ConflictAction;
}

export async function promptForMissingCatalogAction(
  details: MissingCatalogPromptDetails,
): Promise<MissingCatalogAction> {
  note(
    [`Suggested catalog version: ${details.suggested}`, `Resolved from: ${details.resolvedFrom}`].join("\n"),
    `Missing catalog entry: ${details.name}`,
  );
  note(details.occurrences.join("\n"), "Current catalog references");

  const response = await select({
    message: `How should cataloger recover ${details.name}?`,
    options: [
      {
        label: `Restore workspaces.catalog entry with ${details.suggested}`,
        hint: "recommended",
        value: "restore",
      },
      {
        label: "Remove catalog references everywhere",
        hint: "delete only catalog: usages for this package",
        value: "remove",
      },
      {
        label: "Skip for now",
        hint: "leave the repo unchanged for this package",
        value: "skip",
      },
    ],
  });

  if (isCancel(response)) {
    cancel("Cancelled selection. Leaving this package unchanged for now.");
    return "skip";
  }

  return response as MissingCatalogAction;
}
