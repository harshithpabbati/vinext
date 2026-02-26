/**
 * Static export E2E tests — verify exported files work when served via HTTP.
 *
 * Unlike the unit tests in pages-router.test.ts and app-router.test.ts which
 * only check file existence and content, these tests:
 * 1. Run static export for both Pages Router and App Router
 * 2. Serve the exported files with a real HTTP server
 * 3. Make HTTP requests to verify correct responses
 * 4. Check Content-Type, status codes, and asset references
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";

const PAGES_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/pages-basic");
const APP_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/app-basic");

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Simple static file server for testing. */
function createStaticServer(rootDir: string): Promise<{ server: Server; baseUrl: string }> {
  const MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      let pathname = url.split("?")[0];

      // Directory index
      if (pathname.endsWith("/")) pathname += "index.html";
      // Try .html extension for extensionless paths
      let filePath = path.join(rootDir, pathname);
      if (!fs.existsSync(filePath) && !path.extname(filePath)) {
        filePath += ".html";
      }

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        // Serve 404.html if it exists
        const notFoundPath = path.join(rootDir, "404.html");
        if (fs.existsSync(notFoundPath)) {
          const content = fs.readFileSync(notFoundPath);
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end(content);
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
        return;
      }

      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/** Start a Vite dev server for a fixture directory. */
async function startFixtureServer(
  fixtureDir: string,
  _opts?: { appRouter?: boolean },
): Promise<{ server: ViteDevServer; baseUrl: string }> {
  const server = await createViteServer({
    root: fixtureDir,
    configFile: path.join(fixtureDir, "vite.config.ts"),
    server: { port: 0, strictPort: false },
    logLevel: "silent",
  });
  await server.listen();
  const addr = server.httpServer?.address();
  const port = typeof addr === "object" && addr ? addr.port : 4321;
  return { server, baseUrl: `http://localhost:${port}` };
}

// ─── Pages Router Static Export E2E ─────────────────────────────────────────

describe("Static export — Pages Router (served via HTTP)", () => {
  let viteServer: ViteDevServer;
  let staticServer: Server;
  let baseUrl: string;
  const exportDir = path.resolve(PAGES_FIXTURE, "out-e2e");

  beforeAll(async () => {
    // 1. Start Vite dev server for the fixture
    const vite = await startFixtureServer(PAGES_FIXTURE);
    viteServer = vite.server;

    // 2. Run static export
    const { staticExportPages } = await import(
      "../packages/vinext/src/build/static-export.js"
    );
    const { pagesRouter } = await import(
      "../packages/vinext/src/routing/pages-router.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );

    const pagesDir = path.resolve(PAGES_FIXTURE, "pages");
    const routes = await pagesRouter(pagesDir);
    const pageRoutes = routes.filter(
      (r: any) => !r.filePath.includes("/api/"),
    );
    const apiRoutes = routes.filter((r: any) =>
      r.filePath.includes("/api/"),
    );
    const config = await resolveNextConfig({ output: "export" });

    await staticExportPages({
      server: viteServer,
      routes: pageRoutes,
      apiRoutes,
      pagesDir,
      outDir: exportDir,
      config,
    });

    // 3. Start a static file server on the exported directory
    const srv = await createStaticServer(exportDir);
    staticServer = srv.server;
    baseUrl = srv.baseUrl;
  }, 30_000);

  afterAll(async () => {
    staticServer?.close();
    await viteServer?.close();
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  it("serves index.html at / with text/html content type", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Hello, vinext!");
  });

  it("serves about page", async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("serves pre-rendered dynamic route pages", async () => {
    const res = await fetch(`${baseUrl}/blog/hello-world`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("hello-world");
  });

  it("serves 404.html for missing pages", async () => {
    const res = await fetch(`${baseUrl}/nonexistent-page`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("404");
  });

  it("includes __NEXT_DATA__ in served pages", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain("__NEXT_DATA__");
    // Verify it's valid JSON inside the script tag
    const match = html.match(
      /window\.__NEXT_DATA__\s*=\s*({[^<]+})/,
    );
    expect(match).toBeTruthy();
    const data = JSON.parse(match![1]);
    expect(data.props).toBeDefined();
    expect(data.page).toBeDefined();
  });

  it("includes HTML document structure", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain("<html");
    expect(html).toContain("<head>");
    expect(html).toContain("</head>");
    expect(html).toContain("<body");
    expect(html).toContain("</body>");
    expect(html).toContain("</html>");
    expect(html).toContain('<div id="__next">');
  });

  it("getStaticProps pages have correct data in __NEXT_DATA__", async () => {
    const res = await fetch(`${baseUrl}/blog/hello-world`);
    const html = await res.text();
    const match = html.match(
      /window\.__NEXT_DATA__\s*=\s*({[^<]+})/,
    );
    expect(match).toBeTruthy();
    const data = JSON.parse(match![1]);
    expect(data.props.pageProps).toBeDefined();
  });
});

// ─── App Router Static Export E2E ───────────────────────────────────────────

describe("Static export — App Router (served via HTTP)", () => {
  let viteServer: ViteDevServer;
  let viteBaseUrl: string;
  let staticServer: Server;
  let baseUrl: string;
  const exportDir = path.resolve(APP_FIXTURE, "out-e2e");

  beforeAll(async () => {
    // 1. Start Vite dev server for the fixture
    const vite = await startFixtureServer(APP_FIXTURE, { appRouter: true });
    viteServer = vite.server;
    viteBaseUrl = vite.baseUrl;

    // 2. Run static export
    const { staticExportApp } = await import(
      "../packages/vinext/src/build/static-export.js"
    );
    const { appRouter } = await import(
      "../packages/vinext/src/routing/app-router.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );

    const appDir = path.resolve(APP_FIXTURE, "app");
    const routes = await appRouter(appDir);
    const config = await resolveNextConfig({ output: "export" });

    await staticExportApp({
      baseUrl: viteBaseUrl,
      routes,
      appDir,
      server: viteServer,
      outDir: exportDir,
      config,
    });

    // 3. Start a static file server on the exported directory
    const srv = await createStaticServer(exportDir);
    staticServer = srv.server;
    baseUrl = srv.baseUrl;
  }, 30_000);

  afterAll(async () => {
    staticServer?.close();
    await viteServer?.close();
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  it("serves index.html at / with text/html content type", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    const html = await res.text();
    expect(html).toContain("Welcome to App Router");
  });

  it("serves about page", async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("serves pre-rendered dynamic route pages", async () => {
    const res = await fetch(`${baseUrl}/blog/hello-world`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("hello-world");
  });

  it("serves 404.html for missing pages", async () => {
    const res = await fetch(`${baseUrl}/nonexistent-page`);
    expect(res.status).toBe(404);
    const html = await res.text();
    // App Router 404 page
    expect(html.toLowerCase()).toMatch(/not found|404/);
  });

  it("includes complete HTML document structure", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("<head>");
    expect(html).toContain("</head>");
    expect(html).toContain("<body");
    expect(html).toContain("</body>");
  });

  it("HTML contains charset and viewport meta tags", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    // React renders charset as charSet in JSX
    expect(html.toLowerCase()).toMatch(/charset/);
    expect(html).toContain("viewport");
  });

  it("multiple exported pages return distinct content", async () => {
    const [indexRes, aboutRes] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/about`),
    ]);
    const indexHtml = await indexRes.text();
    const aboutHtml = await aboutRes.text();
    // Pages should have different content
    expect(indexHtml).not.toBe(aboutHtml);
    expect(indexHtml).toContain("Welcome to App Router");
    expect(aboutHtml).toContain("About");
  });
});

// ─── prerenderMode: auto build-time pre-rendering ───────────────────────────
//
// Tests the new `prerenderMode: true` option which enables automatic static
// page detection and pre-rendering during a normal server build.
// This matches Next.js's "Automatic Static Optimization" — pages that don't
// use dynamic APIs are pre-rendered to HTML, while dynamic pages are skipped.

describe("prerenderMode — Pages Router (auto build-time pre-rendering)", () => {
  let viteServer: ViteDevServer;
  const prerenderDir = path.resolve(PAGES_FIXTURE, "prerendered-test");

  beforeAll(async () => {
    const vite = await startFixtureServer(PAGES_FIXTURE);
    viteServer = vite.server;

    const { staticExportPages } = await import(
      "../packages/vinext/src/build/static-export.js"
    );
    const { pagesRouter } = await import(
      "../packages/vinext/src/routing/pages-router.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );

    const pagesDir = path.resolve(PAGES_FIXTURE, "pages");
    const routes = await pagesRouter(pagesDir);
    const pageRoutes = routes.filter((r: any) => !r.filePath.includes("/api/"));
    const apiRoutes = routes.filter((r: any) => r.filePath.includes("/api/"));
    const config = await resolveNextConfig({});

    await staticExportPages({
      server: viteServer,
      routes: pageRoutes,
      apiRoutes,
      pagesDir,
      outDir: prerenderDir,
      config,
      prerenderMode: true,
    });
  }, 30_000);

  afterAll(async () => {
    await viteServer?.close();
    fs.rmSync(prerenderDir, { recursive: true, force: true });
  });

  it("pre-renders static pages (no getServerSideProps)", () => {
    // about.tsx is a pure static page — should be pre-rendered
    expect(fs.existsSync(path.join(prerenderDir, "about.html"))).toBe(true);
  });

  it("skips getServerSideProps pages (dynamic)", () => {
    // ssr.tsx uses getServerSideProps — must NOT be pre-rendered
    expect(fs.existsSync(path.join(prerenderDir, "ssr.html"))).toBe(false);
  });

  it("pre-renders dynamic routes with getStaticPaths (any fallback value)", () => {
    // products/[pid].tsx has getStaticPaths with fallback: true and known paths
    // (widget, gadget). In prerenderMode we allow any fallback and render the
    // known paths — matching Next.js's Automatic Static Optimization behavior.
    expect(fs.existsSync(path.join(prerenderDir, "products", "widget.html"))).toBe(true);
    expect(fs.existsSync(path.join(prerenderDir, "products", "gadget.html"))).toBe(true);
  });

  it("pre-renders dynamic routes that have getStaticPaths", () => {
    // blog/[slug].tsx has getStaticPaths with known slugs
    expect(fs.existsSync(path.join(prerenderDir, "blog", "hello-world.html"))).toBe(true);
  });

  it("pre-rendered static HTML is valid", () => {
    const html = fs.readFileSync(path.join(prerenderDir, "about.html"), "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("About");
  });

  it("pre-renders pages/404.tsx as a static page", () => {
    // pages/404.tsx is a plain static page with no getServerSideProps —
    // it is correctly pre-rendered to 404.html (the prod server will serve it
    // for 404 responses, and it's also available as a cached static file).
    expect(fs.existsSync(path.join(prerenderDir, "404.html"))).toBe(true);
    const html = fs.readFileSync(path.join(prerenderDir, "404.html"), "utf-8");
    expect(html).toContain("404");
  });
});

describe("prerenderMode — App Router (auto build-time pre-rendering)", () => {
  let viteServer: ViteDevServer;
  let viteBaseUrl: string;
  const prerenderDir = path.resolve(APP_FIXTURE, "prerendered-test");

  beforeAll(async () => {
    const vite = await startFixtureServer(APP_FIXTURE, { appRouter: true });
    viteServer = vite.server;
    viteBaseUrl = vite.baseUrl;

    const { staticExportApp } = await import(
      "../packages/vinext/src/build/static-export.js"
    );
    const { appRouter } = await import(
      "../packages/vinext/src/routing/app-router.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );

    const appDir = path.resolve(APP_FIXTURE, "app");
    const routes = await appRouter(appDir);
    const config = await resolveNextConfig({});

    await staticExportApp({
      baseUrl: viteBaseUrl,
      routes,
      appDir,
      server: viteServer,
      outDir: prerenderDir,
      config,
      prerenderMode: true,
    });
  }, 30_000);

  afterAll(async () => {
    await viteServer?.close();
    fs.rmSync(prerenderDir, { recursive: true, force: true });
  });

  it("pre-renders pure static pages", () => {
    // app/page.tsx has no dynamic API calls — should be pre-rendered
    expect(fs.existsSync(path.join(prerenderDir, "index.html"))).toBe(true);
  });

  it("pre-renders static about page", () => {
    expect(fs.existsSync(path.join(prerenderDir, "about.html"))).toBe(true);
  });

  it("pre-renders dynamic route pages that have generateStaticParams", () => {
    // blog/[slug]/page.tsx has generateStaticParams returning hello-world, etc.
    expect(fs.existsSync(path.join(prerenderDir, "blog", "hello-world.html"))).toBe(true);
  });

  it("skips pages that use dynamic APIs (cookies/headers)", () => {
    // headers-test/page.tsx calls cookies() and headers() → must NOT be pre-rendered
    expect(fs.existsSync(path.join(prerenderDir, "headers-test.html"))).toBe(false);
  });

  it("pre-rendered HTML is valid and contains page content", () => {
    const html = fs.readFileSync(path.join(prerenderDir, "index.html"), "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Welcome to App Router");
  });

  it("does not generate a 404.html in prerenderMode", () => {
    // In prerenderMode we don't export 404 — the prod server handles it
    expect(fs.existsSync(path.join(prerenderDir, "404.html"))).toBe(false);
  });
});
