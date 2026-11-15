#!/usr/bin/env node
// A head start for your first build of a remix or a proposed build: fetches the parent build's warm build cache
// (compiler cache and intermediates, made only by YouGame's own build machines) and unpacks it where your build reads
// its cache from. Node 22+, no packages. web/public/fetch-build-cache.mjs and plugin/scripts/fetch-build-cache.mjs are
// byte-for-byte copies of this file (test/native-build-cache.test.mjs checks).
//
//   YOUGAME_API_KEY=<your key> node fetch-build-cache.mjs --slug <parent listing> --platform windows|linux|macos \
//     --into <your cache folder> [--build <the build you branched from>] [--remix <your remix's slug>]
//
// --into is the folder your compile cache or engine reads (SCCACHE_DIR, CCACHE_DIR, Unreal's DerivedDataCache, Godot's
// .godot). No cache kept for the listing is normal: build from scratch, nothing else changes.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import { fileURLToPath } from "node:url";

const SITE = "https://yougame.co";
const USAGE =
  "Usage: node fetch-build-cache.mjs --slug <listing> --platform windows|linux|macos --into <dir> [--build <id>] [--remix <your remix slug>] [--site <origin>]";

export function parseArgs(argv) {
  const o = { site: SITE };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (
      !["--slug", "--platform", "--into", "--build", "--remix", "--site"].includes(flag) ||
      value === undefined
    )
      throw new Error(USAGE);
    o[flag.slice(2)] = value;
    i++;
  }
  if (!o.slug || !o.into || !["windows", "linux", "macos"].includes(o.platform))
    throw new Error(USAGE);
  return o;
}

/** A zip entry's place under `root`, or null for anything that would land outside it. */
export function safeTarget(root, name) {
  const clean = name.replace(/\\/g, "/");
  if (
    !clean ||
    clean.includes("\0") ||
    isAbsolute(clean) ||
    /^[A-Za-z]:/.test(clean) ||
    clean.split("/").some((p) => p === "..")
  )
    return null;
  const target = resolve(root, clean);
  return target === root || target.startsWith(root + sep) ? target : null;
}

/** The central directory of a zip of at most 4 GB (a build cache is 2 GB at most): name, method, sizes, header offset. */
export async function listZip(file) {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const tail = Math.min(size, 65_557);
    const buf = Buffer.alloc(tail);
    await fh.read(buf, 0, tail, size - tail);
    const at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (at < 0) throw new Error("not a zip file");
    const count = buf.readUInt16LE(at + 10),
      cdSize = buf.readUInt32LE(at + 12),
      cdAt = buf.readUInt32LE(at + 16);
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdAt);
    const entries = [];
    for (let p = 0, n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip directory");
      const method = cd.readUInt16LE(p + 10),
        packed = cd.readUInt32LE(p + 20),
        unpacked = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28),
        extraLen = cd.readUInt16LE(p + 30),
        commentLen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      entries.push({
        name: cd.toString("utf8", p + 46, p + 46 + nameLen),
        method,
        packed,
        unpacked,
        offset,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    const local = Buffer.alloc(30);
    for (const e of entries) {
      await fh.read(local, 0, 30, e.offset);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("bad zip entry");
      e.dataAt = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    }
    return entries;
  } finally {
    await fh.close();
  }
}

export async function unzipInto(file, into) {
  const root = resolve(into);
  let files = 0;
  for (const e of await listZip(file)) {
    const target = safeTarget(root, e.name);
    if (!target)
      throw new Error(`refusing ${JSON.stringify(e.name)}: it would land outside ${root}`);
    if (e.name.endsWith("/")) {
      await mkdir(target, { recursive: true });
      continue;
    }
    if (e.method !== 0 && e.method !== 8)
      throw new Error(`${e.name}: unsupported zip method ${e.method}`);
    await mkdir(dirname(target), { recursive: true });
    const body = e.packed
      ? createReadStream(file, { start: e.dataAt, end: e.dataAt + e.packed - 1 })
      : Readable.from([]);
    await pipeline(
      body,
      ...(e.method === 8 ? [createInflateRaw()] : []),
      createWriteStream(target),
    );
    if ((await stat(target)).size !== e.unpacked) throw new Error(`${e.name}: size mismatch`);
    files++;
  }
  return files;
}

export async function fetchBuildCache(o, env = process.env, fetchImpl = fetch) {
  const key = env.YOUGAME_API_KEY;
  if (!key) throw new Error("Set YOUGAME_API_KEY to your YouGame key (Account → Your agents → Connect with a key instead).");
  const url = new URL("/api/native/download/cache", o.site);
  for (const k of ["slug", "platform", "build", "remix"]) if (o[k]) url.searchParams.set(k, o[k]);
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${key}` } });
  if (res.status === 404)
    return {
      cache: null,
      message:
        "No build cache is kept for this listing yet. Build from scratch; nothing else changes.",
    };
  if (!res.ok) {
    const why = await res.json().catch(() => ({}));
    throw new Error(`${res.status}: ${why.error ?? res.statusText}`);
  }
  const into = resolve(o.into);
  await mkdir(into, { recursive: true });
  const zip = join(into, ".yougame-cache.zip");
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    const files = await unzipInto(zip, into);
    const build = res.headers.get("x-yougame-cache-build");
    const asked = res.headers.get("x-yougame-cache-asked") === "1";
    return {
      cache: build,
      files,
      message: `Unpacked ${files} cached files from build ${build}${o.build && !asked ? " (the live build's: the one you named has no cache kept)" : ""} into ${into}.`,
    };
  } finally {
    await rm(zip, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = await fetchBuildCache(parseArgs(process.argv.slice(2)));
    console.log(r.message);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
