import type { Collection } from "@nomadvnc/domain";

const STORAGE_KEY = "nomadvnc.desktop.collections.v1";

function isCollection(value: unknown): value is Collection {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<Collection>;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && candidate.name.trim() !== "";
}

function sortCollections(collections: Collection[]): Collection[] {
  return [...collections].sort((left, right) =>
    left.sortOrder !== right.sortOrder
      ? left.sortOrder - right.sortOrder
      : left.name.localeCompare(right.name),
  );
}

export function loadCollections(): Collection[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const now = new Date().toISOString();
    return sortCollections(
      parsed.filter(isCollection).map((entry, index) => ({
        id: entry.id,
        ownerMode: entry.ownerMode ?? "guest",
        name: entry.name.trim(),
        sortOrder: typeof entry.sortOrder === "number" ? entry.sortOrder : index,
        createdAt: entry.createdAt ?? now,
        updatedAt: entry.updatedAt ?? now,
      })),
    );
  } catch {
    return [];
  }
}

export function persistCollections(collections: Collection[]): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(collections));
}

export interface CreateCollectionResult {
  collections: Collection[];
  collection: Collection;
}

/**
 * Creates a group. Returns `null` for blank names or (case-insensitive)
 * duplicates — the caller surfaces the hint.
 */
export function createCollection(
  collections: Collection[],
  name: string,
): CreateCollectionResult | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }
  if (collections.some((entry) => entry.name.toLowerCase() === trimmed.toLowerCase())) {
    return null;
  }
  const now = new Date().toISOString();
  const next: Collection = {
    id: crypto.randomUUID(),
    ownerMode: "guest",
    name: trimmed,
    sortOrder: collections.reduce((max, entry) => Math.max(max, entry.sortOrder), -1) + 1,
    createdAt: now,
    updatedAt: now,
  };
  return { collections: sortCollections([...collections, next]), collection: next };
}

export function deleteCollection(collections: Collection[], id: string): Collection[] {
  return sortCollections(collections.filter((entry) => entry.id !== id));
}
