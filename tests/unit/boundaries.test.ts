import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// src/lib/domain and src/lib/inbox/pipeline are imported by client components, so they must
// not pull in server code: no Node built-ins, no server packages ("server-only", postgres, …),
// nothing under src/lib/server, and no other module of ours that does any of that. Local
// imports ("@/…" and relative) are followed to the end; type-only imports count too.
//
// Pages and layouts under src/app follow the same rule, for a different reason: src/proxy.ts
// lets a page through with any non-empty session cookie (it cannot check one without the
// database), which is only safe while pages read no data on the server. They fetch it from /api
// in the browser, where route() checks the session. A page that imported a service would show
// the owner's data to anyone sending `jt_session=x`.

const ROOT = path.resolve(__dirname, "../..");
const SERVER_DIR = path.join(ROOT, "src/lib/server");
const CLIENT_SAFE_DIRS = ["src/lib/domain", "src/lib/inbox/pipeline"];
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return CODE.test(entry.name) ? [full] : [];
  });
}

/** Every module specifier in the text: import/export ... from, side-effect import, import(), require(). */
function specifiers(source: string) {
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ];
  return patterns.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]));
}

const NODE_BUILTINS = new Set(builtinModules);

/** Packages that only run on the server: the package itself (".js" or not) or any path inside it. */
const SERVER_PACKAGES = ["server-only", "postgres", "undici", "arctic", "htmlparser2", "next/headers", "next/server"];

/** The file or directory a local specifier ("@/…", "./…", "../…") names; null for a package. */
function localTarget(spec: string, file: string): string | null {
  if (spec.startsWith("@/")) return path.join(ROOT, "src", spec.slice(2));
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    return path.resolve(path.dirname(file), spec);
  }
  return null;
}

/** Why `spec`, imported from `file`, is not allowed in client code; null when it is. */
function violation(spec: string, file: string): string | null {
  if (spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0])) return "a Node built-in";
  const isServerPackage = (p: string) => spec === p || spec === `${p}.js` || spec.startsWith(`${p}/`);
  if (SERVER_PACKAGES.some(isServerPackage)) return "a server package";
  const target = localTarget(spec, file);
  if (target && (target === SERVER_DIR || target.startsWith(`${SERVER_DIR}${path.sep}`))) {
    return "server code";
  }
  return null;
}

/** A file's text, or null when there is no such file: the disk here, a fixture in the tests below. */
type ReadSource = (file: string) => string | null;

const readDisk: ReadSource = (file) => {
  try {
    return statSync(file).isFile() ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
};

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** The file a local import loads, as the bundler resolves it: as written, with an extension, or index.*. */
function resolveLocal(target: string, read: ReadSource) {
  const stem = target.replace(/\.(js|jsx|mjs|cjs)$/, ""); // "./x.js" can name x.ts
  const candidates = [
    target,
    ...EXTENSIONS.map((ext) => `${stem}${ext}`),
    ...EXTENSIONS.map((ext) => path.join(target, `index${ext}`)),
  ];
  for (const file of candidates) {
    const source = read(file);
    if (source !== null) return { file, source };
  }
  return null;
}

const rel = (file: string) => path.relative(ROOT, file);

/**
 * Walks `entry` and every local module it imports, transitively. `problems` lists each import
 * that is not allowed as "a.ts → b.ts imports "x": why"; a local import that resolves to no
 * file is one too, so a typo cannot hide a module from the check. `reached` is every file read.
 */
function scan(entry: string, read: ReadSource = readDisk) {
  const problems: string[] = [];
  const reached = new Set<string>();
  const walk = (file: string, source: string, chain: string[]) => {
    reached.add(file);
    const where = chain.map(rel).join(" → ");
    for (const spec of specifiers(source)) {
      const why = violation(spec, file);
      if (why) {
        problems.push(`${where} imports "${spec}": ${why}`);
        continue;
      }
      const target = localTarget(spec, file);
      if (!target) continue; // a package that is not a server one
      const found = resolveLocal(target, read);
      if (!found) problems.push(`${where} imports "${spec}": no such file`);
      else if (!reached.has(found.file) && CODE.test(found.file)) {
        walk(found.file, found.source, [...chain, found.file]);
      }
    }
  };
  const source = read(entry);
  if (source === null) throw new Error(`no such file: ${entry}`);
  walk(entry, source, [entry]);
  return { problems, reached: [...reached].map(rel).sort() };
}

const files = CLIENT_SAFE_DIRS.flatMap((dir) => sourceFiles(path.join(ROOT, dir)));

const at = (file: string) => path.join(ROOT, file);

/** A ReadSource over in-memory files, keyed by repo-relative path. */
const fixture = (sources: Record<string, string>): ReadSource => {
  const byPath = new Map(Object.entries(sources).map(([file, source]) => [at(file), source]));
  return (file) => byPath.get(file) ?? null;
};

describe("client-safe modules", () => {
  it("finds the files and their imports", () => {
    expect(files.map(rel)).toEqual(
      expect.arrayContaining(["src/lib/domain/normalize.ts", "src/lib/inbox/pipeline/classify.ts"]),
    );
    const classify = files.find((f) => f.endsWith("classify.ts"))!;
    expect(specifiers(readFileSync(classify, "utf8"))).toContain("@/lib/domain/normalize");
    // The walk resolves "@/…" on disk and reaches modules outside the two directories.
    expect(scan(classify).reached).toEqual(
      expect.arrayContaining(["src/lib/domain/normalize.ts", "src/lib/inbox/pipeline/classify.ts", "src/lib/types.ts"]),
    );
  });

  it("recognises what is not allowed", () => {
    const file = path.join(ROOT, "src/lib/domain/x.ts");
    const found = (source: string) => specifiers(source).map((s) => violation(s, file));
    expect(found('import { readFile } from "node:fs";')).toEqual(["a Node built-in"]);
    expect(found('import crypto from "crypto";')).toEqual(["a Node built-in"]);
    expect(found('import fs from "fs";\nimport { readFile } from "fs/promises";\nimport path from "path";')).toEqual([
      "a Node built-in",
      "a Node built-in",
      "a Node built-in",
    ]);
    for (const pkg of [
      "server-only",
      "postgres",
      "undici",
      "arctic",
      "htmlparser2",
      "next/headers",
      "next/server",
      "next/headers.js",
      "postgres/cjs/src/index.js",
      "htmlparser2/WritableStream",
    ]) {
      expect(found(`import x from "${pkg}";`), pkg).toEqual(["a server package"]);
    }
    expect(found('import "server-only";')).toEqual(["a server package"]);
    expect(found('const { fetch } = require("undici");')).toEqual(["a server package"]);
    expect(found('import type {\n  Db,\n} from "@/lib/server/db/client";')).toEqual(["server code"]);
    expect(found('export { x } from "../server/schemas";')).toEqual(["server code"]);
    expect(found('const m = await import("@/lib/server");')).toEqual(["server code"]);
    // Allowed: client packages, next's client modules, names that only start like a server one.
    expect(
      found(
        [
          'import { z } from "zod";',
          'import { slug } from "./normalize";',
          'import Link from "next/link";',
          'import { useRouter } from "next/navigation";',
          'import parse from "postgres-array";',
          'import { x } from "@/lib/serverless";',
        ].join("\n"),
      ),
    ).toEqual([null, null, null, null, null, null]);
  });

  describe("follows local imports", () => {
    const problems = (sources: Record<string, string>) =>
      scan(at("src/lib/domain/a.ts"), fixture(sources)).problems;

    it("to a server package, through '@/', relative, '.js' and index imports", () => {
      expect(
        problems({
          "src/lib/domain/a.ts": 'import { b } from "@/lib/util/b";\nexport const a = b;',
          "src/lib/util/b.ts": 'export { c } from "./deep/c.js";',
          "src/lib/util/deep/c.ts": 'import "../../tools";',
          "src/lib/tools/index.ts": 'import postgres from "postgres";',
        }),
      ).toEqual([
        'src/lib/domain/a.ts → src/lib/util/b.ts → src/lib/util/deep/c.ts → src/lib/tools/index.ts imports "postgres": a server package',
      ]);
    });

    it("to a Node built-in and to src/lib/server, type-only imports included", () => {
      expect(
        problems({
          "src/lib/domain/a.ts": 'import { hash } from "../hash";\nimport type { Row } from "./rows";',
          "src/lib/hash.ts": 'import { createHash } from "crypto";',
          "src/lib/domain/rows.ts": 'import type { JobRow } from "@/lib/server/db/rows";',
        }),
      ).toEqual([
        'src/lib/domain/a.ts → src/lib/hash.ts imports "crypto": a Node built-in',
        'src/lib/domain/a.ts → src/lib/domain/rows.ts imports "@/lib/server/db/rows": server code',
      ]);
    });

    it("refuses a local import that resolves to no file", () => {
      expect(problems({ "src/lib/domain/a.ts": 'import { x } from "./missing";' })).toEqual([
        'src/lib/domain/a.ts imports "./missing": no such file',
      ]);
    });

    it("passes clean modules, cycles included", () => {
      const read = fixture({
        "src/lib/domain/a.ts": 'import { z } from "zod";\nimport { b } from "./b";\nimport type { T } from "@/lib/types";',
        "src/lib/domain/b.ts": 'import { a } from "./a";\nimport Link from "next/link";',
        "src/lib/types.ts": "export type T = string;",
      });
      expect(scan(at("src/lib/domain/a.ts"), read)).toEqual({
        problems: [],
        reached: ["src/lib/domain/a.ts", "src/lib/domain/b.ts", "src/lib/types.ts"],
      });
    });
  });

  it.each(files.map((f) => [rel(f), f] as const))("%s imports no server code, directly or not", (_, file) => {
    expect(scan(file).problems).toEqual([]);
  });
});

/**
 * Route handlers (route.ts): the only files under src/app that may run server code. Each one
 * checks the session itself (route(), tests/unit/routes-use-route.test.ts) or is part of sign-in.
 */
const isRouteHandler = (file: string) => /^route\.[^.]+$/.test(path.basename(file));
const appFiles = sourceFiles(path.join(ROOT, "src/app"));
// Everything else Next renders or runs for a page: page, layout, template, loading, error,
// not-found (generateMetadata and generateStaticParams live in these), and any other module
// here, a "use server" action file included.
const pageFiles = appFiles.filter((f) => !isRouteHandler(f));

describe("pages and layouts read no data on the server", () => {
  it("finds the pages, and route handlers only under /api and /auth", () => {
    expect(pageFiles.map(rel)).toEqual(
      expect.arrayContaining([
        "src/app/layout.tsx",
        "src/app/(app)/layout.tsx",
        "src/app/(app)/page.tsx",
        "src/app/(app)/jobs/[id]/page.tsx",
        "src/app/login/page.tsx",
        "src/app/privacy/page.tsx",
      ]),
    );
    expect(pageFiles.filter(isRouteHandler)).toEqual([]);
    const handlers = appFiles.filter(isRouteHandler).map(rel);
    expect(handlers).toContain("src/app/api/jobs/route.ts");
    for (const handler of handlers) expect(handler).toMatch(/^src\/app\/(api|auth)\//);
    // The walk reaches the components a page renders, not just the page file.
    expect(scan(at("src/app/(app)/page.tsx")).reached).toEqual(
      expect.arrayContaining(["src/components/dashboard/dashboard.tsx"]),
    );
  });

  it("catches a page that reads data or the session on the server", () => {
    const problems = (sources: Record<string, string>) =>
      scan(at("src/app/(app)/jobs/[id]/page.tsx"), fixture(sources)).problems;
    // Through a component, as a future "server component that loads the job" would.
    expect(
      problems({
        "src/app/(app)/jobs/[id]/page.tsx": 'import { JobView } from "@/components/jobs/job-view";',
        "src/components/jobs/job-view.tsx": 'import { getJob } from "@/lib/server/services/jobs";',
      }),
    ).toEqual([
      'src/app/(app)/jobs/[id]/page.tsx → src/components/jobs/job-view.tsx imports "@/lib/server/services/jobs": server code',
    ]);
    // generateMetadata reading the cookie to fetch the job's title.
    expect(
      problems({
        "src/app/(app)/jobs/[id]/page.tsx":
          'import { cookies } from "next/headers";\nexport async function generateMetadata() { await cookies(); }',
      }),
    ).toEqual(['src/app/(app)/jobs/[id]/page.tsx imports "next/headers": a server package']);
  });

  it.each(pageFiles.map((f) => [rel(f), f] as const))("%s imports no server code, directly or not", (_, file) => {
    expect(scan(file).problems).toEqual([]);
  });
});

/**
 * The Chrome extension (extension/src): the popup, the service worker and the scripts it puts
 * into pages all run in the browser, and build.mjs bundles whatever they import. They share the
 * app's types and pure helpers through "@/…", which must not lead into server code either.
 */
const extensionFiles = sourceFiles(path.join(ROOT, "extension/src"));

describe("the Chrome extension imports no server code", () => {
  it("finds its files, and follows them into src/", () => {
    expect(extensionFiles.map(rel)).toEqual(
      expect.arrayContaining([
        "extension/src/background.ts",
        "extension/src/connect-bridge.ts",
        "extension/src/popup/main.tsx",
        "extension/src/lib/api.ts",
      ]),
    );
    expect(scan(at("extension/src/popup/main.tsx")).reached).toEqual(
      expect.arrayContaining(["extension/src/lib/api.ts", "src/lib/types.ts", "src/components/add-job/job-form.ts"]),
    );
  });

  it("catches a shared module that reaches the server", () => {
    const problems = scan(
      at("extension/src/lib/api.ts"),
      fixture({
        "extension/src/lib/api.ts": 'import { fit } from "@/lib/fit";\nimport { hash } from "./hash";',
        "src/lib/fit.ts": 'import { limits } from "@/lib/server/schemas";',
        "extension/src/lib/hash.ts": 'import { createHash } from "node:crypto";',
      }),
    ).problems;
    expect(problems).toEqual([
      'extension/src/lib/api.ts → src/lib/fit.ts imports "@/lib/server/schemas": server code',
      'extension/src/lib/api.ts → extension/src/lib/hash.ts imports "node:crypto": a Node built-in',
    ]);
  });

  it.each(extensionFiles.map((f) => [rel(f), f] as const))("%s imports no server code, directly or not", (_, file) => {
    expect(scan(file).problems).toEqual([]);
  });
});
