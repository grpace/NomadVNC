import { beforeEach, describe, expect, it } from "vitest";
import type { Collection } from "@nomadvnc/domain";
import {
  createCollection,
  deleteCollection,
  loadCollections,
  persistCollections,
} from "./collections";

function createEntry(overrides: Partial<Collection> = {}): Collection {
  return {
    id: overrides.id ?? "group-1",
    ownerMode: "guest",
    name: overrides.name ?? "Homelab",
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-02T00:00:00.000Z",
  };
}

describe("collections", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("creates a group with the next sort order", () => {
    const seeded = [createEntry({ id: "a", name: "Alpha", sortOrder: 0 })];
    const result = createCollection(seeded, "  Office  ");

    expect(result).not.toBeNull();
    expect(result?.collection.name).toBe("Office");
    expect(result?.collection.ownerMode).toBe("guest");
    expect(result?.collection.sortOrder).toBe(1);
    expect(result?.collections.map((entry) => entry.name)).toEqual(["Alpha", "Office"]);
  });

  it("rejects blank and duplicate names", () => {
    const seeded = [createEntry({ name: "Homelab" })];
    expect(createCollection(seeded, "   ")).toBeNull();
    expect(createCollection(seeded, "homelab")).toBeNull();
    expect(createCollection(seeded, "HOMELAB")).toBeNull();
  });

  it("persists and reloads groups in order", () => {
    const first = createCollection([], "Zulu")?.collections ?? [];
    const second = createCollection(first, "Alpha")?.collections ?? [];
    persistCollections(second);

    expect(loadCollections().map((entry) => entry.name)).toEqual(["Zulu", "Alpha"]);
  });

  it("deletes a group by id", () => {
    const seeded = [
      createEntry({ id: "a", name: "Alpha" }),
      createEntry({ id: "b", name: "Beta" }),
    ];
    expect(deleteCollection(seeded, "a").map((entry) => entry.id)).toEqual(["b"]);
  });

  it("drops invalid stored entries", () => {
    window.localStorage.setItem(
      "nomadvnc.desktop.collections.v1",
      JSON.stringify([{ id: "a" }, "nope", createEntry({ id: "b", name: "Beta" })]),
    );
    expect(loadCollections().map((entry) => entry.id)).toEqual(["b"]);
  });
});
