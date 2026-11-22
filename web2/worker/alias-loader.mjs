/**
 * Lets the background worker import web2's source the way Next does: "@/x"
 * maps to src/x, and a bare path gets the extension the file actually has.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"];
const TYPESCRIPT = /\.tsx?$/;

function withExtension(base) {
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let base = null;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  }
  const file = base && withExtension(base);
  if (!file) return nextResolve(specifier, context);
  const resolved = await nextResolve(pathToFileURL(file).href, context);
  // web2's package.json has no "type", so say outright that its .ts files are ES modules.
  return TYPESCRIPT.test(file) ? { ...resolved, format: "module-typescript" } : resolved;
}
