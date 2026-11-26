import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const catalog = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8")) as {
  plugins: {
    id: string;
    name: string;
    nameEn: string;
    description: string;
    descriptionEn: string;
    category?: string;
    scope?: string;
    tags?: string[];
    commands?: string[];
  }[];
};

const VALID_CATEGORIES = new Set(["effects", "gameplay", "studio", "import", "publishing", "ai", "motion"]);
const VALID_SCOPES = new Set(["project", "tool"]);

describe("公式プラグインカタログ", () => {
  it("すべてのエントリに検索用メタデータと実体パッケージが揃っている", () => {
    expect(catalog.plugins.length).toBeGreaterThanOrEqual(21);
    const ids = new Set<string>();
    for (const entry of catalog.plugins) {
      expect(ids.has(entry.id), `duplicate id: ${entry.id}`).toBe(false);
      ids.add(entry.id);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.nameEn.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.descriptionEn.length).toBeGreaterThan(0);
      expect(VALID_CATEGORIES.has(entry.category ?? ""), `invalid category: ${entry.id}`).toBe(true);
      expect(VALID_SCOPES.has(entry.scope ?? ""), `invalid scope: ${entry.id}`).toBe(true);
      expect(Array.isArray(entry.tags) && entry.tags.length > 0, `missing tags: ${entry.id}`).toBe(true);

      const dir = join(root, "plugins", entry.id);
      const pkgPath = join(dir, "package.json");
      expect(existsSync(pkgPath), `missing package.json: ${entry.id}`).toBe(true);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        name?: string;
        version?: string;
        liminalia?: { api?: number };
        exports?: Record<string, string>;
      };
      expect(pkg.name).toBeTruthy();
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pkg.liminalia?.api).toBeGreaterThanOrEqual(1);
      const exportsList = Object.values(pkg.exports ?? {});
      expect(exportsList.length).toBeGreaterThan(0);
      for (const rel of exportsList) {
        expect(existsSync(join(dir, rel)), `missing export file ${rel} in ${entry.id}`).toBe(true);
      }
    }
  });
});
