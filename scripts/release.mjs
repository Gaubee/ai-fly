#!/usr/bin/env node
// 发布驱动（RELEASE.md 标准的执行面）：前置检查 → 门禁（typecheck + vitest）
// → 版本对齐（bump 或复用）→ annotated tag → push main + tag。
// 用法：node scripts/release.mjs <version | patch | minor | major>
// CI 侧（release.yml）只信任 tag；本地门禁与 CI 门禁重复是有意的纵深。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { exit } from "node:process";

const arg = process.argv[2];
if (arg === undefined || arg === "--help" || arg === "-h") {
  console.log("usage: node scripts/release.mjs <version | patch | minor | major>");
  exit(arg === undefined ? 1 : 0);
}

const run = (cmd, ...args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const git = (...args) => run("git", ...args).trim();
const fail = (message) => {
  console.error(`release: ${message}`);
  exit(1);
};

// [1] 前置：干净树、main、与远端同步
if (git("status", "--porcelain") !== "") fail("working tree is not clean - commit or stash first");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") fail(`on branch '${branch}' - releases are cut from main`);
git("fetch", "origin", "main");
const [local, remote] = [git("rev-parse", "HEAD"), git("rev-parse", "origin/main")];
if (local !== remote) fail("main is out of sync with origin/main - push/pull first");

// [2] 版本解析
const pkgPath = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version;
const semver = /^(\d+)\.(\d+)\.(\d+)$/;
const match = semver.exec(arg);
const bumpOf = (kind) => {
  const [, major, minor, patch] = semver.exec(current);
  const parts = [Number(major), Number(minor), Number(patch)];
  if (kind === "major") return `${parts[0] + 1}.0.0`;
  if (kind === "minor") return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
};
const target = match !== null ? arg : ["patch", "minor", "major"].includes(arg) ? bumpOf(arg) : fail(`invalid version or bump kind: ${arg}`);
const compare = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  return pa[0] !== pb[0] ? pa[0] - pb[0] : pa[1] !== pb[1] ? pa[1] - pb[1] : pa[2] - pb[2];
};
if (compare(target, current) < 0) fail(`target ${target} is lower than current ${current}`);
const tag = `v${target}`;
if (git("tag", "--list", tag) !== "") fail(`tag ${tag} already exists`);
if (git("ls-remote", "--tags", "origin", tag) !== "") fail(`tag ${tag} already exists on origin`);

console.log(`release: ${current} -> ${target} (${tag})`);

// [3] 门禁：typecheck + vitest（integration/e2e 属实机验证面，不在此列）
console.log("release: gate - typecheck");
run("pnpm", "typecheck");
console.log("release: gate - vitest");
run("pnpm", "test");

// [4] 版本提交（相同版本 = 首发/补发，复用不 bump）
if (target !== current) {
  pkg.version = target;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  git("add", "package.json");
  git("commit", "-m", `chore(release): bump version to ${target}`);
}

// [5] annotated tag + push（tag 即触发器；push main 先行保证 CI 检出的树完整）
git("tag", "-a", tag, "-m", `ai-fly ${tag}`);
git("push", "origin", "main");
git("push", "origin", tag);

console.log(`release: tagged ${tag} and pushed - CI will build, publish to npm (trusted publishing) and open the GitHub Release.`);
console.log("release: watch with  gh run watch  then verify  npm view ai-fly version");
