import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const coreRoot = join(repositoryRoot, "src", "core");
const sourceRoot = join(repositoryRoot, "src");
const adaptersRoot = join(sourceRoot, "adapters");
const adapterRegistry = join(adaptersRoot, "registry.ts");
const failures: string[] = [];

function filesUnder(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) result.push(...filesUnder(path));
    else if (path.endsWith(".ts")) result.push(path);
  }
  return result;
}

const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']/g;

for (const file of filesUnder(coreRoot)) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier) continue;
    if (!specifier.startsWith(".")) {
      if (!specifier.startsWith("node:") && !specifier.startsWith("bun:")) {
        failures.push(
          `${relative(repositoryRoot, file)} imports non-standard dependency: ${specifier}`,
        );
      }
      continue;
    }
    const destination = resolve(dirname(file), specifier);
    const relativeDestination = relative(coreRoot, destination);
    if (
      relativeDestination === ".." ||
      relativeDestination.startsWith(`..\\`) ||
      relativeDestination.startsWith("../")
    ) {
      failures.push(
        `${relative(repositoryRoot, file)} imports outside core: ${specifier}`,
      );
    }
  }
}

for (const file of filesUnder(sourceRoot)) {
  if (file.startsWith(adaptersRoot) || file === adapterRegistry) continue;
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) continue;
    const destination = resolve(dirname(file), specifier);
    if (
      destination === adapterRegistry ||
      destination === adapterRegistry.slice(0, -3)
    ) {
      continue;
    }
    const adapterRelative = relative(adaptersRoot, destination);
    if (
      adapterRelative !== ".." &&
      !adapterRelative.startsWith(`..\\`) &&
      !adapterRelative.startsWith("../")
    ) {
      failures.push(
        `${relative(repositoryRoot, file)} bypasses the adapter registry: ${specifier}`,
      );
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(
  `import boundaries: ${filesUnder(coreRoot).length} core files, ${filesUnder(sourceRoot).length} source files checked`,
);
