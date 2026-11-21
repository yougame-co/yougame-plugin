#!/usr/bin/env node
// Keeps your game's build tree and compile cache between builds, so each build redoes only what changed. Run it before
// you build (or let it run your build): it finds the engine, gives the project a cache home outside the repo, points the
// engine's caches at it, fetches the parent build's warm cache on the first build of a remix or proposed build, prints
// the command that builds just the one OS and configuration you are uploading, and says afterwards how much the cache
// saved. Node 22+, no packages. It never uploads anything, never installs anything, and writes only inside the project's
// own cache folders and its cache home. web/public/build-keep.mjs and plugin/scripts/build-keep.mjs are byte-for-byte
// copies of this file (test/build-keep.test.mjs checks).
//
//   node build-keep.mjs [setup] <project> [--platform windows|linux|macos|web] [--config <name>]
//                       [--parent <listing slug> [--build <id>] [--remix <your remix slug>]]
//   node build-keep.mjs run <project> [same options] -- <your build command>
//   node build-keep.mjs stats <project>
//
// The cache home is ~/.yougame/build-cache/<project>-<id>/ (YOUGAME_BUILD_CACHE or --home moves the root). Compile caches
// there are shared by every checkout of the same repo on this machine; build trees are kept per checkout folder.
// --parent needs YOUGAME_API_KEY in the environment (only fetch-build-cache.mjs reads it; nothing here prints it).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage:
  node build-keep.mjs [setup] <project> [--platform windows|linux|macos|web] [--config <name>]
                      [--parent <listing slug> [--build <id>] [--remix <your remix slug>]] [--engine <name>] [--home <dir>] [--site <origin>] [--json]
  node build-keep.mjs run <project> [same options] -- <your build command>
  node build-keep.mjs stats <project> [--home <dir>]`;

const SITE = "https://yougame.co";
const PLATFORMS = ["windows", "linux", "macos", "web"];
const ENGINES = ["unreal", "unity", "godot", "rust", "cmake", "web"];

export function hostPlatform(p = process.platform) {
  return p === "win32" ? "windows" : p === "darwin" ? "macos" : "linux";
}

export function parseArgs(argv) {
  const o = { mode: "setup", project: null, command: [] };
  const args = [...argv];
  const dash = args.indexOf("--");
  if (dash >= 0) o.command = args.splice(dash).slice(1);
  if (["setup", "run", "stats"].includes(args[0])) o.mode = args.shift();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      o.json = true;
      continue;
    }
    if (
      [
        "--platform",
        "--config",
        "--parent",
        "--build",
        "--remix",
        "--engine",
        "--home",
        "--site",
      ].includes(a)
    ) {
      if (args[i + 1] === undefined) throw new Error(USAGE);
      o[a.slice(2)] = args[++i];
      continue;
    }
    if (a.startsWith("--") || o.project) throw new Error(USAGE);
    o.project = a;
  }
  o.project = resolve(o.project ?? ".");
  if (o.platform && !PLATFORMS.includes(o.platform)) throw new Error(USAGE);
  if (o.engine && !ENGINES.includes(o.engine)) throw new Error(USAGE);
  return o;
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Every engine the folder looks like, most specific first (an Unreal project can carry a package.json too). */
export function detectEngines(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found = [];
  const uproject = names.find((n) => n.endsWith(".uproject"));
  if (uproject) found.push({ engine: "unreal", uproject });
  if (names.includes("Assets") && names.includes("ProjectSettings"))
    found.push({ engine: "unity" });
  if (names.includes("project.godot")) found.push({ engine: "godot" });
  if (names.includes("Cargo.toml")) found.push({ engine: "rust" });
  if (names.includes("CMakeLists.txt")) found.push({ engine: "cmake" });
  if (names.includes("package.json")) {
    let pkg = {};
    try {
      pkg = JSON.parse(readText(join(dir, "package.json")));
    } catch {}
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const bundler = ["vite", "webpack", "esbuild", "rollup", "parcel", "@rspack/core"].find(
      (b) => b in deps,
    );
    if (bundler || pkg.scripts?.build)
      found.push({ engine: "web", bundler: bundler ?? null, buildScript: !!pkg.scripts?.build });
  }
  return found;
}

/** Which compile caches are installed, from PATH alone (nothing is run or installed). */
export function findTools(env = process.env, platform = process.platform) {
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const dirs = (env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : delimiter)
    .filter(Boolean);
  const has = (name) =>
    dirs.some((d) =>
      exts.some(
        (e) => existsSync(join(d, name + e.toLowerCase())) || existsSync(join(d, name + e)),
      ),
    );
  return {
    ccache: has("ccache"),
    sccache: has("sccache"),
    ninja: has("ninja"),
    emcmake: has("emcmake"),
  };
}

const short = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** The repo's identity: its origin remote when it has one (so a fresh clone finds the same compile cache), else the folder. */
export function projectKey(dir) {
  const git = spawnSync("git", ["-C", dir, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  });
  const remote = git.status === 0 ? git.stdout.trim().replace(/\/\/[^/@]*@/, "//") : "";
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {}
  const name = (basename(real) || "project").replace(/[^\w.-]+/g, "-").slice(0, 40);
  return { name, repo: short(remote || real), checkout: short(real) };
}

export function cacheHome(key, o = {}, env = process.env) {
  const root = o.home ?? env.YOUGAME_BUILD_CACHE ?? join(homedir(), ".yougame", "build-cache");
  return resolve(root, `${key.name}-${key.repo}`);
}

const UNREAL_PLATFORM = { windows: "Win64", linux: "Linux", macos: "Mac" };
const RUST_TARGET = {
  windows: "x86_64-pc-windows-msvc",
  linux: "x86_64-unknown-linux-gnu",
  macos: "aarch64-apple-darwin",
  web: "wasm32-unknown-unknown",
};
const GODOT_PLATFORM = {
  windows: /windows/i,
  linux: /linux|x11/i,
  macos: /mac/i,
  web: /web|html5/i,
};

function godotPreset(dir, platform) {
  const presets = [];
  for (const block of readText(join(dir, "export_presets.cfg"))
    .split(/^\[preset\.\d+\]\s*$/m)
    .slice(1)) {
    const name = block.match(/^name="([^"]*)"/m)?.[1];
    const plat = block.match(/^platform="([^"]*)"/m)?.[1] ?? "";
    if (name) presets.push({ name, platform: plat });
  }
  return presets.find((p) => GODOT_PLATFORM[platform].test(p.platform))?.name ?? null;
}

const OPERATORS = new Set(["&&", "||", ";", "|"]);
/** One shell line from argv: operators stay bare, anything unusual is quoted for this OS's shell. */
export function shellLine(argv, platform = process.platform) {
  return argv
    .map((s) =>
      OPERATORS.has(s) || /^[\w./:=@+,-]+$/.test(s)
        ? s
        : platform === "win32"
          ? `"${s.replace(/"/g, '""')}"`
          : `'${s.replace(/'/g, "'\\''")}'`,
    )
    .join(" ");
}
const q = (s) => shellLine([s]);

/**
 * What to keep, where, and the one command that builds only this OS and configuration. Pure: everything it needs comes
 * in through `x` (tools found, cache home, state), so tests run it without any engine installed.
 */
export function planBuild(x) {
  const { dir, engine, platform, home, tools = {}, state = {}, key } = x;
  const config = x.config ?? (engine === "unreal" ? "Shipping" : "Release");
  const tree = join(
    home,
    "trees",
    `${key?.checkout ?? "local"}-${platform}-${config}`.toLowerCase(),
  );
  const out = join(home, "out", `${platform}-${config}`.toLowerCase());
  const env = {};
  const keep = []; // folders kept between builds (inside the project, or in the cache home)
  const notes = [];
  let command = null;
  let cacheDir = null; // where a parent's warm cache is unpacked (fetch-build-cache --into)
  let clearOut = false;

  const compilerCache = () => {
    if (tools.sccache) {
      env.SCCACHE_DIR = join(home, "sccache");
      return { tool: "sccache", dir: env.SCCACHE_DIR };
    }
    if (tools.ccache) {
      env.CCACHE_DIR = join(home, "ccache");
      return { tool: "ccache", dir: env.CCACHE_DIR };
    }
    notes.push(
      "Install sccache (or ccache) to cache compiler output between builds; nothing else here needs it.",
    );
    return null;
  };

  if (engine === "unreal") {
    keep.push(join(dir, "Intermediate"), join(dir, "Binaries"), join(dir, "DerivedDataCache"));
    if (state.unrealDdc) {
      env["UE-LocalDataCachePath"] = state.unrealDdc;
      keep.push(state.unrealDdc);
    } else
      notes.push(
        "Unreal's own local DerivedDataCache (in your user folder) already lasts between builds; it stays where it is.",
      );
    cacheDir = state.unrealDdc ?? join(home, "ddc");
    notes.push(
      "Never pass -clean or delete Intermediate/ or Binaries/: that is what makes the next build incremental.",
    );
    if (platform === "web") {
      notes.push(
        "Package the web (Wasm) build as https://yougame.co/unreal/guide says, without -clean, into the folder below.",
      );
    } else {
      const uat =
        platform === "windows"
          ? "<UE>\\Engine\\Build\\BatchFiles\\RunUAT.bat"
          : "<UE>/Engine/Build/BatchFiles/RunUAT.sh";
      command = [
        uat,
        "BuildCookRun",
        `-project=${join(dir, x.uproject ?? "Game.uproject")}`,
        `-platform=${UNREAL_PLATFORM[platform]}`,
        `-clientconfig=${config}`,
        "-build",
        "-cook",
        "-stage",
        "-pak",
        "-archive",
        `-archivedirectory=${out}`,
        "-nop4",
        "-utf8output",
      ];
    }
    clearOut = true;
  } else if (engine === "unity") {
    keep.push(join(dir, "Library"));
    cacheDir = isDir(join(dir, "Library")) ? null : join(dir, "Library");
    const flag = {
      windows: ["-buildWindows64Player", join(out, "Game.exe")],
      macos: ["-buildOSXUniversalPlayer", join(out, "Game.app")],
      linux: ["-buildLinux64Player", join(out, "Game.x86_64")],
    }[platform];
    command = [
      "<Unity>",
      "-batchmode",
      "-quit",
      "-projectPath",
      dir,
      ...(flag ?? ["-buildTarget", "WebGL", "-executeMethod", "<YourBuildScript.BuildWebGL>"]),
      "-logFile",
      "-",
    ];
    notes.push(
      "Library/ is Unity's import cache: keep it, and keep the same Unity version, so only changed assets reimport.",
    );
    clearOut = true;
  } else if (engine === "godot") {
    keep.push(join(dir, ".godot"));
    cacheDir = isDir(join(dir, ".godot")) ? null : join(dir, ".godot");
    const preset = godotPreset(dir, platform);
    if (!preset)
      notes.push(
        `export_presets.cfg has no ${platform} preset yet: add one in Project > Export, then run this again.`,
      );
    command = [
      "godot",
      "--headless",
      "--path",
      dir,
      "--export-release",
      preset ?? `<your ${platform} preset>`,
      join(out, platform === "web" ? "index.html" : platform === "windows" ? "Game.exe" : "Game"),
    ];
    notes.push(".godot/ holds the imported assets: keep it so only changed assets reimport.");
    clearOut = true;
  } else if (engine === "rust") {
    const target = join(dir, "target");
    if (isDir(target)) keep.push(target);
    else {
      env.CARGO_TARGET_DIR = join(tree, "cargo");
      keep.push(env.CARGO_TARGET_DIR);
    }
    if (tools.sccache) {
      env.RUSTC_WRAPPER = "sccache";
      env.SCCACHE_DIR = join(home, "sccache");
      cacheDir = env.SCCACHE_DIR;
    } else
      notes.push(
        "Install sccache to share compiled crates between checkouts; target/ already keeps this one incremental.",
      );
    const cross = platform !== hostPlatform();
    command = [
      "cargo",
      "build",
      ...(config.toLowerCase() === "debug" ? [] : ["--release"]),
      ...(cross ? ["--target", RUST_TARGET[platform]] : []),
    ];
  } else if (engine === "cmake") {
    const existing = ["build", "out/build", "cmake-build-release"]
      .map((b) => join(dir, b))
      .find((b) => existsSync(join(b, "CMakeCache.txt")));
    const build = existing ?? join(tree, "cmake");
    keep.push(build);
    const cc = compilerCache();
    if (cc) {
      env.CMAKE_C_COMPILER_LAUNCHER = cc.tool;
      env.CMAKE_CXX_COMPILER_LAUNCHER = cc.tool;
      cacheDir = cc.dir;
    }
    const configure = [
      "cmake",
      "-S",
      dir,
      "-B",
      build,
      `-DCMAKE_BUILD_TYPE=${config}`,
      ...(tools.ninja && !existing ? ["-G", "Ninja"] : []),
    ];
    if (platform === "web") {
      env.EM_CACHE = join(home, "emcache");
      keep.push(env.EM_CACHE);
      if (tools.ccache) env.EM_COMPILER_WRAPPER = "ccache";
      configure.unshift("emcmake");
    }
    command = [...configure, "&&", "cmake", "--build", build, "--config", config, "--parallel"];
    if (existing) notes.push(`Kept your existing build folder ${existing}.`);
  } else if (engine === "web") {
    keep.push(join(dir, "node_modules"));
    const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"].find((f) =>
      existsSync(join(dir, f)),
    );
    const pm = { "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "bun.lockb": "bun" }[lock] ?? "npm";
    const installed = isDir(join(dir, "node_modules"));
    command = [...(installed ? [] : [pm, "install", "&&"]), pm, "run", "build"];
    notes.push(
      `node_modules/ holds the bundler cache (.vite, .cache): keep it. Reinstall only when the lockfile changes, and never with \`${pm === "npm" ? "npm ci" : `${pm} install --force`}\`, which wipes it.`,
    );
  }
  if (clearOut)
    notes.push(
      `The build is exported fresh into ${out} (emptied before each build): upload that folder.`,
    );
  return {
    engine,
    platform,
    config,
    home,
    env,
    keep: [...new Set(keep)],
    notes,
    command,
    cacheDir,
    out: clearOut ? out : null,
  };
}

export function envLines(env, platform = hostPlatform()) {
  return Object.entries(env).map(([k, v]) =>
    platform === "windows"
      ? `\${env:${k}} = '${v.replace(/'/g, "''")}'`
      : /^\w+$/.test(k)
        ? `export ${k}=${q(v)}`
        : `# ${k}=${v}  (not a shell name: use \`build-keep.mjs run\`, which sets it)`,
  );
}

/** The compile cache's hit/miss counters, when the tool reports them; null when it doesn't. */
export function cacheStats(env, tools = findTools(env)) {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, {
      env,
      encoding: "utf8",
      timeout: 30_000,
      shell: process.platform === "win32",
    });
    return r.status === 0 ? r.stdout : null;
  };
  if (tools.sccache && env.SCCACHE_DIR) {
    const out = run("sccache", ["--show-stats", "--stats-format=json"]);
    try {
      const s = JSON.parse(out).stats;
      const sum = (o) => Object.values(o?.counts ?? {}).reduce((a, b) => a + b, 0);
      return { tool: "sccache", hits: sum(s.cache_hits), misses: sum(s.cache_misses) };
    } catch {
      return null;
    }
  }
  if (tools.ccache && env.CCACHE_DIR) {
    const out = run("ccache", ["--print-stats"]);
    if (!out) return null;
    const n = Object.fromEntries(
      out
        .split("\n")
        .map((l) => l.split("\t"))
        .filter((p) => p.length === 2)
        .map(([k, v]) => [k, Number(v)]),
    );
    if (!("cache_miss" in n)) return null;
    return {
      tool: "ccache",
      hits: (n.direct_cache_hit ?? 0) + (n.preprocessed_cache_hit ?? 0),
      misses: n.cache_miss,
    };
  }
  return null;
}

/** Bytes under a folder, stopping after `cap` entries (a big engine cache can hold millions of files). */
export function folderBytes(dir, cap = 200_000) {
  let bytes = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < cap) {
    const d = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > cap) break;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          bytes += statSync(p).size;
        } catch {}
      }
    }
  }
  return { bytes, partial: seen >= cap };
}

const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

async function readState(home) {
  try {
    return JSON.parse(await readFile(join(home, "state.json"), "utf8"));
  } catch {
    return {};
  }
}

const CACHE_KIND = {
  sccache: "sccache",
  ccache: "ccache",
  DerivedDataCache: "ddc",
  ddc: "ddc",
  ".godot": ".godot",
  Library: "Library",
};

/**
 * Moves an unpacked parent cache to where this build reads it. A zip holding one cache folder (sccache/,
 * DerivedDataCache/, .godot/ ...) gives that folder, and only to a cache of the same kind (an sccache cache is no use to
 * ccache); any other zip is the cache itself. Never overwrites a cache that already has files: the parent's is only a
 * head start for a first build. Answers "placed", "kept" (target had files) or "mismatch".
 */
export async function placeParentCache(staging, target) {
  const existing = await readdir(target).catch(() => null);
  if (existing?.length) return "kept";
  const top = await readdir(staging, { withFileTypes: true });
  const one =
    top.length === 1 && top[0].isDirectory() && CACHE_KIND[top[0].name] ? top[0].name : null;
  if (one && CACHE_KIND[one] !== CACHE_KIND[basename(target)]) return "mismatch";
  const src = one ? join(staging, one) : staging;
  if (existing) await rmdir(target);
  await mkdir(join(target, ".."), { recursive: true });
  try {
    await rename(src, target);
  } catch (e) {
    if (e?.code !== "EXDEV") throw e;
    await cp(src, target, { recursive: true });
  }
  return "placed";
}

/** Fetch the parent's warm cache once, through the fetch-build-cache.mjs beside this file. Never fatal. */
async function fetchParent(o, plan, state, log) {
  if (!o.parent || state.parentFetched || !plan.cacheDir || plan.platform === "web") return null;
  if (!process.env.YOUGAME_API_KEY) {
    log(
      "No YOUGAME_API_KEY set, so no head start from the parent build: this first build starts cold, nothing else changes.",
    );
    return null;
  }
  const helper = new URL("./fetch-build-cache.mjs", import.meta.url);
  if (!existsSync(fileURLToPath(helper))) {
    log(
      "fetch-build-cache.mjs is not next to this file (download it from https://yougame.co/fetch-build-cache.mjs): building cold.",
    );
    return null;
  }
  const staging = join(plan.home, "parent-cache");
  try {
    await rm(staging, { recursive: true, force: true });
    const { fetchBuildCache } = await import(helper.href);
    const r = await fetchBuildCache({
      slug: o.parent,
      platform: plan.platform,
      into: staging,
      build: o.build,
      remix: o.remix,
      site: o.site ?? SITE,
    });
    log(r.message);
    const how = r.cache ? await placeParentCache(staging, plan.cacheDir) : null;
    const placed = how === "placed";
    if (placed) log(`It is in ${plan.cacheDir} now.`);
    if (how === "kept")
      log(
        `${plan.cacheDir} already has files, so it stays as it is; the parent's cache was not used.`,
      );
    if (how === "mismatch")
      log(
        "The parent's cache is for a different compile cache than the one installed here, so it was not used.",
      );
    // Recorded either way: the head start is for the first build only, so later runs don't ask again.
    return { slug: o.parent, build: r.cache ?? null, placed, at: new Date().toISOString() };
  } catch (e) {
    log(`Parent cache not fetched (${e instanceof Error ? e.message : e}); building cold.`);
    return null;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function setup(o, log = console.log) {
  const found = detectEngines(o.project);
  const pick = o.engine
    ? (found.find((f) => f.engine === o.engine) ?? { engine: o.engine })
    : found[0];
  if (!pick)
    throw new Error(
      `No engine found in ${o.project}: looked for a .uproject, Assets/+ProjectSettings/, project.godot, Cargo.toml, CMakeLists.txt or a package.json with a build.`,
    );
  const key = projectKey(o.project);
  const home = cacheHome(key, o);
  await mkdir(home, { recursive: true });
  const state = await readState(home);
  const platform = o.platform ?? (pick.engine === "web" ? "web" : hostPlatform());
  const tools = findTools();
  let plan = planBuild({
    dir: o.project,
    engine: pick.engine,
    uproject: pick.uproject,
    platform,
    config: o.config,
    home,
    tools,
    state,
    key,
  });
  const fetched = await fetchParent(o, plan, state, log);
  if (fetched) {
    state.parentFetched = fetched;
    if (fetched.placed && pick.engine === "unreal") state.unrealDdc = plan.cacheDir;
    plan = planBuild({
      dir: o.project,
      engine: pick.engine,
      uproject: pick.uproject,
      platform,
      config: o.config,
      home,
      tools,
      state,
      key,
    });
  }
  for (const p of plan.keep) if (p.startsWith(home)) await mkdir(p, { recursive: true });
  for (const p of Object.values(plan.env))
    if (p.startsWith(home)) await mkdir(p, { recursive: true });
  if (plan.out) {
    await rm(plan.out, { recursive: true, force: true });
    await mkdir(plan.out, { recursive: true });
  }
  await writeFile(
    join(home, "state.json"),
    JSON.stringify(
      {
        ...state,
        project: o.project,
        engine: plan.engine,
        lastPlatform: platform,
        lastConfig: plan.config,
      },
      null,
      2,
    ),
  );
  return { plan, tools, others: found.filter((f) => f !== pick).map((f) => f.engine) };
}

function report({ plan, others }, o, log) {
  if (o.json) return log(JSON.stringify(plan, null, 2));
  log(
    `${plan.engine} project, building ${plan.platform} ${plan.config} only. Cache home: ${plan.home}`,
  );
  if (others.length) log(`(Also looks like: ${others.join(", ")}; pass --engine to pick another.)`);
  log(`Kept between builds:\n${plan.keep.map((k) => `  ${k}`).join("\n")}`);
  if (Object.keys(plan.env).length)
    log(
      `Environment for the build:\n${envLines(plan.env)
        .map((l) => `  ${l}`)
        .join("\n")}`,
    );
  if (plan.command) log(`Build only this one target:\n  ${shellLine(plan.command)}`);
  for (const n of plan.notes) log(`- ${n}`);
  log(
    plan.command && !plan.command.some((a) => a.includes("<"))
      ? `Easiest: node build-keep.mjs run ${q(o.project)} --platform ${plan.platform} runs that command with this environment and reports the cache afterwards.`
      : `Easiest: node build-keep.mjs run ${q(o.project)} --platform ${plan.platform} -- <your build command> sets this environment and reports the cache afterwards.`,
  );
}

function summary(plan, before, t0) {
  const after = cacheStats({ ...process.env, ...plan.env });
  const size = folderBytes(plan.home);
  const parts = [
    `Build took ${Math.round((Date.now() - t0) / 1000)}s`,
    `cache home ${size.partial ? "over " : ""}${gb(size.bytes)}`,
  ];
  if (after) {
    const hits = after.hits - (before?.hits ?? 0);
    const misses = after.misses - (before?.misses ?? 0);
    const total = hits + misses;
    parts.push(
      `${after.tool}: ${hits} hits, ${misses} misses${total ? ` (${Math.round((100 * hits) / total)}% reused)` : ""}`,
    );
  } else if (plan.env.SCCACHE_DIR || plan.env.CCACHE_DIR)
    parts.push("compile cache counters unavailable");
  return parts.join("; ") + ".";
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE);
  const o = parseArgs(argv);
  const log = (s) => (o.mode === "run" || !o.json ? console.log(s) : null);
  if (o.mode === "stats") {
    const key = projectKey(o.project);
    const home = cacheHome(key, o);
    const state = await readState(home);
    if (!state.engine) return console.log(`No cache home yet for ${o.project}: run setup first.`);
    const plan = planBuild({
      dir: o.project,
      engine: state.engine,
      platform: state.lastPlatform,
      config: state.lastConfig,
      home,
      tools: findTools(),
      state,
      key,
    });
    const s = cacheStats({ ...process.env, ...plan.env });
    const size = folderBytes(home);
    return console.log(
      `Cache home ${home}: ${size.partial ? "over " : ""}${gb(size.bytes)}${s ? `; ${s.tool}: ${s.hits} hits, ${s.misses} misses in total` : ""}.`,
    );
  }
  const r = await setup(o, log);
  if (o.mode === "setup") return report(r, o, console.log);
  const command = o.command.length ? o.command : r.plan.command;
  if (!command || command.some((a) => a.includes("<"))) {
    report(r, o, console.log);
    throw new Error(
      "run needs your build command after -- for this engine (fill in the placeholders above).",
    );
  }
  const env = { ...process.env, ...r.plan.env };
  const before = cacheStats(env, r.tools); // also starts sccache's server with this SCCACHE_DIR when none is running
  const t0 = Date.now();
  console.log(
    `build-keep: ${r.plan.engine} ${r.plan.platform} ${r.plan.config}, cache home ${r.plan.home}`,
  );
  // One shell line, so a command with && (configure, then build) runs as written.
  const child = spawnSync(command.length === 1 ? command[0] : shellLine(command), {
    stdio: "inherit",
    env,
    cwd: o.project,
    shell: true,
  });
  console.log(`build-keep: ${summary(r.plan, before, t0)}`);
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
