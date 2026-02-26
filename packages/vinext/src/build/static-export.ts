/**
 * Static export for `output: 'export'`.
 *
 * Renders all pages to static HTML files at build time. Produces a directory
 * of HTML + client JS/CSS that can be deployed to any static file host
 * (S3, Cloudflare Pages, GitHub Pages, Nginx, etc.) with no server required.
 *
 * Pages Router:
 *   - Static pages → render to HTML
 *   - getStaticProps pages → call at build time, render with props
 *   - Dynamic routes → call getStaticPaths (must be fallback: false), render each
 *   - getServerSideProps → build error
 *   - API routes → skipped with warning
 *
 * App Router:
 *   - Static pages → run Server Components at build time, render to HTML
 *   - Dynamic routes → call generateStaticParams(), render each
 *   - Dynamic routes without generateStaticParams → build error
 */
import type { ViteDevServer } from "vite";
import type { Route } from "../routing/pages-router.js";
import type { AppRoute } from "../routing/app-router.js";
import type { ResolvedNextConfig } from "../config/next-config.js";
import { safeJsonStringify } from "../server/html.js";
import { escapeAttr } from "../shims/head.js";
import path from "node:path";
import fs from "node:fs";
import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";

const PAGE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

function findFileWithExtensions(basePath: string): boolean {
  return PAGE_EXTENSIONS.some((ext) => fs.existsSync(basePath + ext));
}

/**
 * Render a React element to string using renderToReadableStream (Suspense support).
 * Uses Web Streams API — works in Node.js 18+ and Cloudflare Workers.
 */
async function renderToStringAsync(element: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

export interface StaticExportOptions {
  /** Vite dev server (for SSR module loading) */
  server: ViteDevServer;
  /** Discovered page routes (excludes API routes) */
  routes: Route[];
  /** Discovered API routes */
  apiRoutes: Route[];
  /** Pages directory path */
  pagesDir: string;
  /** Output directory for static files */
  outDir: string;
  /** Resolved next.config.js */
  config: ResolvedNextConfig;
  /**
   * When true, enables automatic build-time pre-rendering mode:
   * - Skips pages with getServerSideProps (instead of erroring)
   * - Skips dynamic routes without getStaticPaths (instead of erroring)
   * - Allows getStaticPaths with any fallback value (renders known paths)
   * Use this when pre-rendering as part of a normal server build (not output:'export').
   */
  prerenderMode?: boolean;
}

export interface StaticExportResult {
  /** Number of HTML files generated */
  pageCount: number;
  /** Generated file paths (relative to outDir) */
  files: string[];
  /** Warnings encountered */
  warnings: string[];
  /** Errors encountered (non-fatal, specific pages) */
  errors: Array<{ route: string; error: string }>;
}

/**
 * Run static export for Pages Router.
 *
 * Creates a directory of static HTML files by rendering each route at build time.
 */
export async function staticExportPages(
  options: StaticExportOptions,
): Promise<StaticExportResult> {
  const { server, routes, apiRoutes, pagesDir, outDir, config } = options;
  const prerenderMode = options.prerenderMode ?? false;
  const result: StaticExportResult = {
    pageCount: 0,
    files: [],
    warnings: [],
    errors: [],
  };

  // Ensure output directory exists
  fs.mkdirSync(outDir, { recursive: true });

  // Warn about API routes
  if (!prerenderMode && apiRoutes.length > 0) {
    result.warnings.push(
      `${apiRoutes.length} API route(s) skipped — API routes are not supported with output: 'export'`,
    );
  }

  // Gather all pages to render (expand dynamic routes via getStaticPaths)
  const pagesToRender: Array<{
    route: Route;
    urlPath: string;
    params: Record<string, string | string[]>;
  }> = [];

  for (const route of routes) {
    // Skip internal pages
    const routeName = path.basename(route.filePath, path.extname(route.filePath));
    if (routeName.startsWith("_")) continue;

    const pageModule = await server.ssrLoadModule(route.filePath);

    // getServerSideProps pages are not statically renderable
    if (typeof pageModule.getServerSideProps === "function") {
      if (prerenderMode) {
        // In auto-prerender mode: skip SSR pages — they'll be rendered at runtime
        continue;
      }
      result.errors.push({
        route: route.pattern,
        error: `Page uses getServerSideProps which is not supported with output: 'export'. Use getStaticProps instead.`,
      });
      continue;
    }

    if (route.isDynamic) {
      // Dynamic route — must have getStaticPaths
      if (typeof pageModule.getStaticPaths !== "function") {
        if (prerenderMode) {
          // In auto-prerender mode: skip — will be SSR'd at runtime
          continue;
        }
        result.errors.push({
          route: route.pattern,
          error: `Dynamic route requires getStaticPaths with output: 'export'`,
        });
        continue;
      }

      const pathsResult = await pageModule.getStaticPaths({
        locales: [],
        defaultLocale: "",
      });
      const fallback = pathsResult?.fallback ?? false;

      if (!prerenderMode && fallback !== false) {
        result.errors.push({
          route: route.pattern,
          error: `getStaticPaths must return fallback: false with output: 'export' (got: ${JSON.stringify(fallback)})`,
        });
        continue;
      }

      const paths: Array<{ params: Record<string, string | string[]> }> =
        pathsResult?.paths ?? [];

      for (const { params } of paths) {
        // Build the URL path from the route pattern and params
        const urlPath = buildUrlFromParams(route.pattern, params);
        pagesToRender.push({ route, urlPath, params });
      }
    } else {
      // Static route — render directly
      pagesToRender.push({ route, urlPath: route.pattern, params: {} });
    }
  }

  // Load shared components (_app, _document, head shim, dynamic shim)
  let AppComponent: React.ComponentType<{
    Component: React.ComponentType;
    pageProps: Record<string, unknown>;
  }> | null = null;
  const appPath = path.join(pagesDir, "_app");
  if (findFileWithExtensions(appPath)) {
    try {
      const appModule = await server.ssrLoadModule(appPath);
      AppComponent = appModule.default ?? null;
    } catch {
      // _app exists but failed to load
    }
  }

  let DocumentComponent: React.ComponentType | null = null;
  const docPath = path.join(pagesDir, "_document");
  if (findFileWithExtensions(docPath)) {
    try {
      const docModule = await server.ssrLoadModule(docPath);
      DocumentComponent = docModule.default ?? null;
    } catch {
      // _document exists but failed to load
    }
  }

  const headShim = await server.ssrLoadModule("next/head");
  const dynamicShim = await server.ssrLoadModule("next/dynamic");
  const routerShim = await server.ssrLoadModule("next/router");

  // Render each page
  for (const { route, urlPath, params } of pagesToRender) {
    try {
      const html = await renderStaticPage({
        server,
        route,
        urlPath,
        params,
        pagesDir,
        config,
        AppComponent,
        DocumentComponent,
        headShim,
        dynamicShim,
        routerShim,
      });

      const outputPath = getOutputPath(urlPath, config.trailingSlash);
      const fullPath = path.join(outDir, outputPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, html, "utf-8");

      result.files.push(outputPath);
      result.pageCount++;
    } catch (e) {
      result.errors.push({
        route: urlPath,
        error: (e as Error).message,
      });
    }
  }

  // Render 404 page
  try {
    const html404 = await renderErrorPage({
      server,
      pagesDir,
      statusCode: 404,
      AppComponent,
      DocumentComponent,
      headShim,
    });
    if (html404) {
      const fullPath = path.join(outDir, "404.html");
      fs.writeFileSync(fullPath, html404, "utf-8");
      result.files.push("404.html");
      result.pageCount++;
    }
  } catch {
    // No custom 404, skip
  }

  return result;
}

interface RenderStaticPageOptions {
  server: ViteDevServer;
  route: Route;
  urlPath: string;
  params: Record<string, string | string[]>;
  pagesDir: string;
  config: ResolvedNextConfig;
  AppComponent: React.ComponentType<{
    Component: React.ComponentType;
    pageProps: Record<string, unknown>;
  }> | null;
  DocumentComponent: React.ComponentType | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headShim: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dynamicShim: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routerShim: any;
}

async function renderStaticPage(options: RenderStaticPageOptions): Promise<string> {
  const {
    server,
    route,
    urlPath,
    params,
    config: _config,
    AppComponent,
    DocumentComponent,
    headShim,
    dynamicShim,
    routerShim,
  } = options;

  // Set SSR context for router shim
  if (typeof routerShim.setSSRContext === "function") {
    routerShim.setSSRContext({
      pathname: urlPath,
      query: params,
      asPath: urlPath,
    });
  }

  const pageModule = await server.ssrLoadModule(route.filePath);
  const PageComponent = pageModule.default;
  if (!PageComponent) {
    throw new Error(`Page ${route.filePath} has no default export`);
  }

  // Collect page props
  let pageProps: Record<string, unknown> = {};

  if (typeof pageModule.getStaticProps === "function") {
    const result = await pageModule.getStaticProps({ params });
    if (result && "props" in result) {
      pageProps = result.props as Record<string, unknown>;
    }
    if (result && "redirect" in result) {
      // Static export can't handle redirects — write a meta redirect
      const redirect = result.redirect as { destination: string };
      return `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${escapeAttr(redirect.destination)}" /></head><body></body></html>`;
    }
    if (result && "notFound" in result && result.notFound) {
      throw new Error(`Page ${urlPath} returned notFound: true`);
    }
  }

  // Build element
  const createElement = React.createElement;
  let element: React.ReactElement;

  if (AppComponent) {
    element = createElement(AppComponent, {
      Component: PageComponent,
      pageProps,
    });
  } else {
    element = createElement(PageComponent, pageProps);
  }

  // Reset head collector and flush dynamic preloads
  if (typeof headShim.resetSSRHead === "function") {
    headShim.resetSSRHead();
  }
  if (typeof dynamicShim.flushPreloads === "function") {
    await dynamicShim.flushPreloads();
  }

  // Render page body
  const bodyHtml = await renderToStringAsync(element);

  // Collect head tags
  const ssrHeadHTML =
    typeof headShim.getSSRHeadHTML === "function"
      ? headShim.getSSRHeadHTML()
      : "";

  // __NEXT_DATA__ for client hydration
  const nextDataScript = `<script>window.__NEXT_DATA__ = ${safeJsonStringify({
    props: { pageProps },
    page: route.pattern,
    query: params,
  })}</script>`;

  // Build HTML shell
  let html: string;

  if (DocumentComponent) {
    const docElement = createElement(DocumentComponent);
    // renderToReadableStream auto-prepends <!DOCTYPE html> when root is <html>
    let docHtml = await renderToStringAsync(docElement);
    docHtml = docHtml.replace("__NEXT_MAIN__", bodyHtml);
    if (ssrHeadHTML) {
      docHtml = docHtml.replace("</head>", `  ${ssrHeadHTML}\n</head>`);
    }
    docHtml = docHtml.replace("<!-- __NEXT_SCRIPTS__ -->", nextDataScript);
    if (!docHtml.includes("__NEXT_DATA__")) {
      docHtml = docHtml.replace("</body>", `  ${nextDataScript}\n</body>`);
    }
    html = docHtml;
  } else {
    html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${ssrHeadHTML}
</head>
<body>
  <div id="__next">${bodyHtml}</div>
  ${nextDataScript}
</body>
</html>`;
  }

  // Clear SSR context
  if (typeof routerShim.setSSRContext === "function") {
    routerShim.setSSRContext(null);
  }

  return html;
}

interface RenderErrorPageOptions {
  server: ViteDevServer;
  pagesDir: string;
  statusCode: number;
  AppComponent: React.ComponentType<{
    Component: React.ComponentType;
    pageProps: Record<string, unknown>;
  }> | null;
  DocumentComponent: React.ComponentType | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headShim: any;
}

async function renderErrorPage(
  options: RenderErrorPageOptions,
): Promise<string | null> {
  const { server, pagesDir, statusCode, AppComponent, DocumentComponent, headShim } =
    options;

  const candidates =
    statusCode === 404
      ? ["404", "_error"]
      : statusCode === 500
        ? ["500", "_error"]
        : ["_error"];

  for (const candidate of candidates) {
    const candidatePath = path.join(pagesDir, candidate);
    if (!findFileWithExtensions(candidatePath)) continue;

    const errorModule = await server.ssrLoadModule(candidatePath);
    const ErrorComponent = errorModule.default;
    if (!ErrorComponent) continue;

    const createElement = React.createElement;
    const errorProps = { statusCode };

    let element: React.ReactElement;
    if (AppComponent) {
      element = createElement(AppComponent, {
        Component: ErrorComponent,
        pageProps: errorProps,
      });
    } else {
      element = createElement(ErrorComponent, errorProps);
    }

    if (typeof headShim.resetSSRHead === "function") {
      headShim.resetSSRHead();
    }

    const bodyHtml = await renderToStringAsync(element);

    let html: string;
    if (DocumentComponent) {
      const docElement = createElement(DocumentComponent);
      let docHtml = await renderToStringAsync(docElement);
      docHtml = docHtml.replace("__NEXT_MAIN__", bodyHtml);
      docHtml = docHtml.replace("<!-- __NEXT_SCRIPTS__ -->", "");
      html = docHtml;
    } else {
      html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <div id="__next">${bodyHtml}</div>
</body>
</html>`;
    }

    return html;
  }

  return null;
}

/**
 * Build a URL path from a route pattern and params.
 * E.g., "/posts/:id" + { id: "42" } → "/posts/42"
 * E.g., "/docs/:slug+" + { slug: ["a", "b"] } → "/docs/a/b"
 */
function buildUrlFromParams(
  pattern: string,
  params: Record<string, string | string[]>,
): string {
  const parts = pattern.split("/").filter(Boolean);
  const result: string[] = [];

  for (const part of parts) {
    if (part.endsWith("+") || part.endsWith("*")) {
      // Catch-all: :slug+ or :slug*
      const paramName = part.slice(1, -1);
      const value = params[paramName];
      if (Array.isArray(value)) {
        result.push(...value);
      } else if (value) {
        result.push(String(value));
      }
    } else if (part.startsWith(":")) {
      // Dynamic segment: :id
      const paramName = part.slice(1);
      const value = params[paramName];
      result.push(String(value));
    } else {
      result.push(part);
    }
  }

  return "/" + result.join("/");
}

/**
 * Determine the output file path for a given URL.
 * Respects trailingSlash config.
 */
function getOutputPath(urlPath: string, trailingSlash: boolean): string {
  if (urlPath === "/") {
    return "index.html";
  }

  // Remove leading slash
  const clean = urlPath.replace(/^\//, "");

  if (trailingSlash) {
    return `${clean}/index.html`;
  }
  return `${clean}.html`;
}

/**
 * Resolve parent dynamic segment params for a route.
 *
 * Implements Next.js's top-down params passing for generateStaticParams().
 * Walks up the route hierarchy to find parent dynamic segments that have their
 * own generateStaticParams. Collects parent params by calling each parent's
 * generateStaticParams in order, merging results top-down.
 *
 * Returns an array of parent param combinations. If empty, the child should
 * be called with `{ params: {} }` (bottom-up approach).
 */
async function resolveParentParams(
  childRoute: AppRoute,
  allRoutes: AppRoute[],
  server: ViteDevServer,
): Promise<Record<string, string | string[]>[]> {
  // Extract the dynamic segment names from the pattern
  const patternParts = childRoute.pattern.split("/").filter(Boolean);

  // Identify parent dynamic segments: each :param in the pattern except the last one(s)
  // that belong to the leaf page's directory.
  // Strategy: find ancestor routes (layout-level) that export generateStaticParams.
  // An ancestor route's pattern is a prefix of the child's pattern.

  // Collect parent segments with generateStaticParams by looking at page modules
  // along the ancestor path. We look for pages/layouts that define generateStaticParams
  // at each level of the path hierarchy.
  type ParentSegment = {
    params: string[];
    generateStaticParams: (opts: { params: Record<string, string | string[]> }) => Promise<Record<string, string | string[]>[]>;
  };

  const parentSegments: ParentSegment[] = [];

  // Walk pattern parts to find intermediate dynamic segments
  // For /products/:category/:id, we look for a route or layout at /products/:category
  // that has generateStaticParams
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (!part.startsWith(":")) continue;

    // Check if this is not the last dynamic param (i.e., it's a parent segment)
    const isLastDynamicPart = !patternParts.slice(i + 1).some((p) => p.startsWith(":"));
    if (isLastDynamicPart) break; // This is the child's own segment

    // Build the prefix pattern up to this segment
    const prefixPattern = "/" + patternParts.slice(0, i + 1).join("/");

    // Find a route at this prefix that has generateStaticParams
    const parentRoute = allRoutes.find((r) => r.pattern === prefixPattern);
    if (parentRoute?.pagePath) {
      try {
        const parentModule = await server.ssrLoadModule(parentRoute.pagePath);
        if (typeof parentModule.generateStaticParams === "function") {
          const paramName = part.replace(/^:/, "").replace(/[+*]$/, "");
          parentSegments.push({
            params: [paramName],
            generateStaticParams: parentModule.generateStaticParams,
          });
        }
      } catch {
        // Skip — parent module couldn't be loaded
      }
    }
  }

  if (parentSegments.length === 0) return [];

  // Top-down resolution: call each parent's generateStaticParams in order,
  // accumulating params
  let currentParams: Record<string, string | string[]>[] = [{}];

  for (const segment of parentSegments) {
    const nextParams: Record<string, string | string[]>[] = [];
    for (const parentParams of currentParams) {
      const results = await segment.generateStaticParams({ params: parentParams });
      if (Array.isArray(results)) {
        for (const result of results) {
          nextParams.push({ ...parentParams, ...result });
        }
      }
    }
    currentParams = nextParams;
  }

  return currentParams;
}

// -------------------------------------------------------------------
// App Router static export
// -------------------------------------------------------------------

export interface AppStaticExportOptions {
  /**
   * Base URL of a running dev server (e.g. "http://localhost:5173").
   * Required for output: 'export' mode. Not used in prerenderMode.
   */
  baseUrl?: string;
  /** Discovered app routes */
  routes: AppRoute[];
  /** App directory path (for loading modules to call generateStaticParams) */
  appDir: string;
  /** Vite dev server (for loading page modules) */
  server: ViteDevServer;
  /** Output directory */
  outDir: string;
  /** Resolved next.config.js */
  config: ResolvedNextConfig;
  /**
   * When true, enables automatic build-time pre-rendering mode:
   * - Pages are rendered directly in-process (no HTTP server needed)
   * - Dynamic APIs (cookies, headers, connection) throw DynamicServerError,
   *   causing the page to be skipped — it will be SSR'd at request time
   * - Skips dynamic routes without generateStaticParams() (instead of erroring)
   * Use this when pre-rendering as part of a normal server build (not output:'export').
   */
  prerenderMode?: boolean;
}

/**
 * Check if an error is a DynamicServerError thrown when a dynamic API
 * (cookies, headers, connection) is called during static generation.
 * Uses the `digest` property so the check works across module instances.
 */
function isDynamicServerError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e as { digest?: string }).digest === "DYNAMIC_SERVER_ERROR"
  );
}

/**
 * Run static export for App Router in prerenderMode.
 *
 * Renders each statically-determinable page directly in-process by:
 * 1. Loading the page module and checking for explicit dynamic markers
 *    (export const dynamic = 'force-dynamic', revalidate = 0).
 * 2. Calling generateStaticParams() for dynamic routes.
 * 3. Building the React layout+page tree and rendering with renderToReadableStream.
 * 4. Entering static generation mode so that any call to cookies(), headers(),
 *    or connection() throws DynamicServerError — causing the page to be skipped.
 *
 * This mirrors Next.js's build-time static optimization: pages that use dynamic
 * APIs are detected during the render attempt and skipped automatically.
 */
async function prerenderAppRoutes(
  options: Pick<AppStaticExportOptions, "routes" | "server" | "outDir" | "config">,
  result: StaticExportResult,
): Promise<void> {
  const { routes, server, outDir, config } = options;

  // Load the navigation shim from the Vite SSR module graph so that
  // setNavigationContext() writes to the same instance the page components read.
  const navigationShim = await server.ssrLoadModule("next/navigation");

  // Load the headers shim to enter/exit static generation mode.
  const headersShim = await server.ssrLoadModule("next/headers");

  for (const route of routes) {
    // Skip API route handlers — not supported in static pre-rendering
    if (route.routePath && !route.pagePath) continue;
    if (!route.pagePath) continue;

    let pageModule: Record<string, unknown>;
    try {
      pageModule = await server.ssrLoadModule(route.pagePath);
    } catch {
      continue;
    }

    // Respect explicit dynamic markers (same as Next.js).
    if (pageModule.dynamic === "force-dynamic") continue;
    if (typeof pageModule.revalidate === "number" && pageModule.revalidate === 0) continue;

    // Build the list of (urlPath, params) to render for this route.
    const toRender: Array<{ urlPath: string; params: Record<string, string | string[]> }> = [];

    if (route.isDynamic) {
      if (typeof pageModule.generateStaticParams !== "function") {
        // No generateStaticParams — skip (will be SSR'd at runtime)
        continue;
      }

      try {
        const parentParamSets = await resolveParentParams(route, routes, server);

        let paramSets: Record<string, string | string[]>[];
        if (parentParamSets.length > 0) {
          paramSets = [];
          for (const parentParams of parentParamSets) {
            const childResults = await (pageModule.generateStaticParams as Function)({ params: parentParams });
            if (Array.isArray(childResults)) {
              for (const childParams of childResults) {
                paramSets.push({ ...parentParams, ...childParams });
              }
            }
          }
        } else {
          paramSets = await (pageModule.generateStaticParams as Function)({ params: {} });
        }

        if (!Array.isArray(paramSets) || paramSets.length === 0) {
          result.warnings.push(
            `generateStaticParams() for ${route.pattern} returned empty array — no pages generated`,
          );
          continue;
        }

        for (const params of paramSets) {
          toRender.push({ urlPath: buildUrlFromParams(route.pattern, params), params });
        }
      } catch (e) {
        result.errors.push({
          route: route.pattern,
          error: `Failed to call generateStaticParams(): ${(e as Error).message}`,
        });
        continue;
      }
    } else {
      toRender.push({ urlPath: route.pattern, params: {} });
    }

    // Load layout modules for this route (from root to leaf).
    const layoutModules: Array<Record<string, unknown>> = [];
    for (const layoutPath of route.layouts) {
      try {
        layoutModules.push(await server.ssrLoadModule(layoutPath));
      } catch {
        layoutModules.push({});
      }
    }

    // Render each URL in-process.
    for (const { urlPath, params } of toRender) {
      try {
        // Provide navigation context so usePathname() / useParams() work.
        if (typeof navigationShim.setNavigationContext === "function") {
          navigationShim.setNavigationContext({
            pathname: urlPath,
            searchParams: new URLSearchParams(),
            params,
          });
        }

        // Enter static generation mode — dynamic API calls will throw DynamicServerError.
        if (typeof headersShim.enterStaticGenerationMode === "function") {
          headersShim.enterStaticGenerationMode();
        }

        const Page = pageModule.default as React.ComponentType<unknown>;
        if (!Page) continue;

        // Next.js 15+ passes params as a thenable (can be awaited OR accessed directly).
        const thenableParams = Object.assign(Promise.resolve(params), params);

        // Build the React tree: Page wrapped in layouts (outermost first).
        let element: React.ReactElement = React.createElement(Page as React.ComponentType<Record<string, unknown>>, {
          params: thenableParams,
          searchParams: Promise.resolve({}),
        });

        for (let i = layoutModules.length - 1; i >= 0; i--) {
          const Layout = layoutModules[i]?.default as React.ComponentType<unknown> | undefined;
          if (Layout) {
            element = React.createElement(Layout as React.ComponentType<Record<string, unknown>>, {
              children: element,
              params: thenableParams,
            });
          }
        }

        // Render to HTML. renderToReadableStream handles async Server Components
        // and waits for all Suspense boundaries when allReady resolves.
        const stream = await renderToReadableStream(element);
        await stream.allReady;
        const html = "<!DOCTYPE html>\n" + (await new Response(stream).text());

        const outputPath = getOutputPath(urlPath, config.trailingSlash);
        const fullPath = path.join(outDir, outputPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, html, "utf-8");

        result.files.push(outputPath);
        result.pageCount++;
      } catch (e) {
        // DynamicServerError: the page called cookies(), headers(), or connection()
        // during render — it cannot be pre-rendered and will be SSR'd at runtime.
        if (isDynamicServerError(e)) continue;
        // Other errors: log but continue with remaining pages.
        result.errors.push({ route: urlPath, error: (e as Error).message });
      } finally {
        if (typeof headersShim.exitStaticGenerationMode === "function") {
          headersShim.exitStaticGenerationMode();
        }
        if (typeof navigationShim.setNavigationContext === "function") {
          navigationShim.setNavigationContext(null);
        }
      }
    }
  }
}

/**
 * Run static export for App Router.
 *
 * In prerenderMode: renders pages directly in-process at build time (no HTTP
 * server needed). Pages that call dynamic APIs are detected and skipped.
 *
 * In output:'export' mode: fetches each route from a running dev server and
 * writes the HTML to disk. Requires baseUrl to point to a running dev server.
 */
export async function staticExportApp(
  options: AppStaticExportOptions,
): Promise<StaticExportResult> {
  const { routes, server, outDir, config } = options;
  const prerenderMode = options.prerenderMode ?? false;
  const result: StaticExportResult = {
    pageCount: 0,
    files: [],
    warnings: [],
    errors: [],
  };

  fs.mkdirSync(outDir, { recursive: true });

  if (prerenderMode) {
    // Build-time approach: render pages directly in-process.
    await prerenderAppRoutes({ routes, server, outDir, config }, result);
    return result;
  }

  // ── output: 'export' mode — HTTP-based rendering ────────────────────────
  // Requires a running dev server at baseUrl.
  const baseUrl = options.baseUrl ?? "";

  // Collect all URLs to render
  const urlsToRender: string[] = [];

  for (const route of routes) {
    // Skip API route handlers — not supported in static export
    if (route.routePath && !route.pagePath) {
      result.warnings.push(
        `Route handler ${route.pattern} skipped — API routes are not supported with output: 'export'`,
      );
      continue;
    }

    if (!route.pagePath) continue;

    if (route.isDynamic) {
      // Dynamic route — must have generateStaticParams
      try {
        const pageModule = await server.ssrLoadModule(route.pagePath);

        if (typeof pageModule.generateStaticParams !== "function") {
          result.errors.push({
            route: route.pattern,
            error: `Dynamic route requires generateStaticParams() with output: 'export'`,
          });
          continue;
        }

        const parentParamSets = await resolveParentParams(route, routes, server);

        let paramSets: Record<string, string | string[]>[];
        if (parentParamSets.length > 0) {
          paramSets = [];
          for (const parentParams of parentParamSets) {
            const childResults = await pageModule.generateStaticParams({ params: parentParams });
            if (Array.isArray(childResults)) {
              for (const childParams of childResults) {
                paramSets.push({ ...parentParams, ...childParams });
              }
            }
          }
        } else {
          paramSets = await pageModule.generateStaticParams({ params: {} });
        }

        if (!Array.isArray(paramSets) || paramSets.length === 0) {
          result.warnings.push(
            `generateStaticParams() for ${route.pattern} returned empty array — no pages generated`,
          );
          continue;
        }

        for (const params of paramSets) {
          const urlPath = buildUrlFromParams(route.pattern, params);
          urlsToRender.push(urlPath);
        }
      } catch (e) {
        result.errors.push({
          route: route.pattern,
          error: `Failed to call generateStaticParams(): ${(e as Error).message}`,
        });
      }
    } else {
      // Static route
      urlsToRender.push(route.pattern);
    }
  }

  // Fetch each URL from the dev server and write HTML
  for (const urlPath of urlsToRender) {
    try {
      const res = await fetch(`${baseUrl}${urlPath}`);
      if (!res.ok) {
        result.errors.push({
          route: urlPath,
          error: `Server returned ${res.status}`,
        });
        continue;
      }

      const html = await res.text();
      const outputPath = getOutputPath(urlPath, config.trailingSlash);
      const fullPath = path.join(outDir, outputPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, html, "utf-8");

      result.files.push(outputPath);
      result.pageCount++;
    } catch (e) {
      result.errors.push({
        route: urlPath,
        error: (e as Error).message,
      });
    }
  }

  // Render 404 page
  try {
    const res = await fetch(`${baseUrl}/__nonexistent_page_for_404__`);
    if (res.status === 404) {
      const html = await res.text();
      if (html.length > 0) {
        const fullPath = path.join(outDir, "404.html");
        fs.writeFileSync(fullPath, html, "utf-8");
        result.files.push("404.html");
        result.pageCount++;
      }
    }
  } catch {
    // No custom 404, skip
  }

  return result;
}
