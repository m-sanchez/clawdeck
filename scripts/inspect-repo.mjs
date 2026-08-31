#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { resolvePanelContext } from "./lib/context.mjs";

async function readPackage(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function dependencySet(pkg) {
  return new Set([
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.devDependencies ?? {}),
    ...Object.keys(pkg?.peerDependencies ?? {}),
  ]);
}

async function detectProjects(root) {
  const names = [
    "client",
    "server",
    "management-client",
    "management-server",
    "shared",
  ];
  const projects = [];

  for (const name of names) {
    const projectRoot = join(root, name);
    const packagePath = join(projectRoot, "package.json");
    const pkg = await readPackage(packagePath);
    if (!pkg) continue;
    const deps = dependencySet(pkg);
    projects.push({
      name,
      root: projectRoot,
      packagePath,
      packageName: pkg.name ?? null,
      scripts: Object.keys(pkg.scripts ?? {}),
      nodeModulesPresent: existsSync(join(projectRoot, "node_modules")),
      tooling: {
        angular: deps.has("@angular/core"),
        angularCli: deps.has("@angular/cli"),
        typescript: deps.has("typescript"),
        rxjs: deps.has("rxjs"),
        apollo: deps.has("apollo-angular") || deps.has("@apollo/client"),
        vite: deps.has("vite"),
        esbuild: deps.has("esbuild"),
        webpack: deps.has("webpack"),
        express: deps.has("express"),
        fastify: deps.has("fastify"),
        vitest: deps.has("vitest"),
        jest: deps.has("jest"),
        playwright: deps.has("@playwright/test") || deps.has("playwright"),
      },
    });
  }

  const rootPkg = await readPackage(join(root, "package.json"));
  if (rootPkg) {
    const deps = dependencySet(rootPkg);
    projects.unshift({
      name: "root",
      root,
      packagePath: join(root, "package.json"),
      packageName: rootPkg.name ?? null,
      scripts: Object.keys(rootPkg.scripts ?? {}),
      nodeModulesPresent: existsSync(join(root, "node_modules")),
      tooling: {
        angular: deps.has("@angular/core"),
        angularCli: deps.has("@angular/cli"),
        typescript: deps.has("typescript"),
        rxjs: deps.has("rxjs"),
        apollo: deps.has("apollo-angular") || deps.has("@apollo/client"),
        vite: deps.has("vite"),
        esbuild: deps.has("esbuild"),
        webpack: deps.has("webpack"),
        express: deps.has("express"),
        fastify: deps.has("fastify"),
        vitest: deps.has("vitest"),
        jest: deps.has("jest"),
        playwright: deps.has("@playwright/test") || deps.has("playwright"),
      },
    });
  }

  return projects;
}

async function listClaudeEntries(root, subdir) {
  const path = join(root, ".claude", subdir);
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}

const context = resolvePanelContext();
const projects = await detectProjects(context.checkoutRoot);
const commands = await listClaudeEntries(context.checkoutRoot, "commands");
const scripts = await listClaudeEntries(context.checkoutRoot, "scripts");

const angularProject = projects.find(
  (project) => project.tooling.angular && project.tooling.angularCli,
);
const lightBundlerProject = projects.find(
  (project) => project.tooling.vite || project.tooling.esbuild,
);
const serverProject = projects.find(
  (project) => project.tooling.express || project.tooling.fastify,
);

const assessment = {
  generatedAt: new Date().toISOString(),
  repoRoot: context.repoRoot,
  checkoutRoot: context.checkoutRoot,
  checkoutId: context.checkoutId,
  branch: context.branch ?? null,
  isWorktree: context.isWorktree,
  node: {
    version: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  projects,
  claude: {
    commands,
    scripts,
    hasWorktreesDirectory: existsSync(
      join(context.checkoutRoot, ".claude", "worktrees"),
    ),
    likelyWorktreeCommands: commands.filter((name) =>
      /wt-|worktree/i.test(name),
    ),
    likelyWorktreeScripts: scripts.filter((name) => /wt-|worktree/i.test(name)),
  },
  recommendation: {
    ui: angularProject
      ? `Prefer a small standalone Angular entry using installed tooling from ${basename(angularProject.root)}; verify bootstrap isolation first.`
      : lightBundlerProject
        ? `Prefer framework-independent TypeScript using installed bundler tooling from ${basename(lightBundlerProject.root)}.`
        : "Use the zero-dependency starter initially and identify an installed TypeScript/bundler path before introducing dependencies.",
    server: serverProject
      ? `A local server may reuse installed server tooling from ${basename(serverProject.root)} through a controlled adapter boundary.`
      : "The included Node HTTP starter is a valid local-server foundation.",
    packageInstallAllowed: false,
  },
};

const output = join(context.panelRoot, "repo-assessment.json");
await writeFile(output, `${JSON.stringify(assessment, null, 2)}\n`, "utf8");
console.log(`Repository assessment written to ${output}`);
console.log(JSON.stringify(assessment.recommendation, null, 2));
