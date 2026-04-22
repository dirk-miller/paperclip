import fs from "node:fs";
import path from "node:path";

function toGlobstarPath(candidate: string): string {
  return `${candidate.replaceAll(path.sep, "/")}/**`;
}

function addIgnorePath(target: Set<string>, candidate: string): void {
  target.add(candidate);
  target.add(toGlobstarPath(candidate));
  try {
    const realPath = fs.realpathSync(candidate);
    target.add(realPath);
    target.add(toGlobstarPath(realPath));
  } catch {
    // Ignore paths that do not exist in the current checkout.
  }
}

export function resolveServerDevWatchIgnorePaths(serverRoot: string): string[] {
  const ignorePaths = new Set<string>([
    "**/{node_modules,bower_components,vendor}/**",
    "**/.vite-temp/**",
  ]);

  for (const relativePath of [
    "../ui/node_modules",
    "../ui/node_modules/.vite-temp",
    "../ui/.vite",
    "../ui/dist",
    // npm install during reinstall would trigger a restart mid-request
    // if tsx watch sees the new files. Exclude the managed plugins dir.
    process.env.HOME + "/.paperclip/adapter-plugins",
  ]) {
    addIgnorePath(ignorePaths, path.resolve(serverRoot, relativePath));
  }

  // iCloud Drive sync creates metadata files that trigger false-positive
  // restarts when the server source tree lives under an iCloud-synced path.
  // (f7621e7a adapted — moved from tsx --ignore flags to this resolver)
  for (const pattern of [
    "**/.DS_Store",
    "**/*.icloud",
    "**/._*",
    "**/.Spotlight-*",
    "**/.Trashes",
    "**/node_modules/**/dist/**",
  ]) {
    ignorePaths.add(pattern);
  }

  return [...ignorePaths];
}
