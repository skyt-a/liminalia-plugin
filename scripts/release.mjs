import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "dist");
const release = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(release ?? "")) throw new Error("Usage: npm run build -- v0.1.0");
const entries = ["commands", "web", "import", "studio", "studio-server", "cli", "build"];
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const encode = (data) => Buffer.from(JSON.stringify(data) + "\n");
const file = (path, data = readFileSync(join(root, path))) => ({ path, base64: Buffer.from(data).toString("base64") });

function sourceFiles(dir, folder) {
  return readdirSync(join(dir, folder), { withFileTypes: true }).flatMap((entry) => {
    const name = join(folder, entry.name).split("\\").join("/");
    if (entry.isDirectory()) return sourceFiles(dir, name);
    if (!entry.isFile() || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(entry.name)) throw new Error(`Unexpected file: ${name}`);
    return [file(name, readFileSync(join(dir, name)))];
  });
}

async function bundleServer(dir, pkg, files) {
  const dependencies = new Set(Object.keys(pkg.dependencies));
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(dir, pkg.exports["./studio-server"])],
    outfile: join(out, "studio-server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["@liminalia/sdk/*"],
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    legalComments: "inline",
    metafile: true,
    write: false,
  });
  files.push(file("dist/studio-server.mjs", result.outputFiles[0].contents));
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const matches = [...input.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
    const match = matches.at(-1);
    if (match) packages.add(input.slice(0, match.index + match[0].length));
  }
  const notices = [...packages].sort().map((path) => {
    const dir = join(root, path);
    const pkg = json(join(dir, "package.json"));
    dependencies.delete(pkg.name);
    const license = readdirSync(dir).find((name) => /^(licen[sc]e|copying)(\.[\w.]+)?$/i.test(name));
    if (!license) throw new Error(`License file missing: ${pkg.name}`);
    return `${pkg.name} ${pkg.version}\n\n${readFileSync(join(dir, license), "utf8")}`;
  });
  if (dependencies.size) throw new Error(`Dependencies missing from bundle: ${[...dependencies].join(", ")}`);
  files.push(file("THIRD_PARTY_NOTICES.txt", notices.join("\n\n")));
  pkg.exports["./studio-server"] = "./dist/studio-server.mjs";
  delete pkg.dependencies;
}

mkdirSync(out, { recursive: true });
const catalog = json(join(root, "catalog.json"));
const plugins = [];
for (const entry of catalog.plugins) {
  const dir = join(root, "plugins", entry.id);
  const pkg = json(join(dir, "package.json"));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || !Number.isSafeInteger(pkg.liminalia?.api)) throw new Error(`Missing version or API: ${entry.id}`);
  const files = [file("LICENSE"), ...sourceFiles(dir, "src")];
  if (existsSync(join(dir, "README.md"))) files.push(file("README.md", readFileSync(join(dir, "README.md"))));
  if (pkg.dependencies) {
    if (entry.id !== "remote-connect") throw new Error(`Unexpected runtime dependencies: ${entry.id}`);
    await bundleServer(dir, pkg, files);
  }
  const exports = entries.filter((key) => {
    const path = pkg.exports[`./${key}`];
    if (path === undefined) return false;
    if (!files.some((f) => "./" + f.path === path)) throw new Error(`Missing export: ${pkg.name}/${key}`);
    return true;
  });
  files.push(file("package.json", JSON.stringify(pkg, null, 2) + "\n"));
  const payload = encode({ schemaVersion: 1, files });
  const asset = join(out, `${entry.id}.limplugin.json`);
  writeFileSync(asset, payload);
  plugins.push({ ...entry, packageName: pkg.name, version: pkg.version, entries: exports, api: pkg.liminalia.api, release, sha256: createHash("sha256").update(payload).digest("hex") });
  console.log(`${relative(root, asset)} (${payload.length} bytes)`);
}
writeFileSync(join(out, "catalog.json"), encode({ schemaVersion: 1, plugins }));
