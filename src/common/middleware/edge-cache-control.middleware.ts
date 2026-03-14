const EDGE_CONTENT_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=30";
const EDGE_PROFILE_CACHE_CONTROL = "public, s-maxage=10, stale-while-revalidate=5";
const NO_STORE_CACHE_CONTROL = "no-store";

const AUTH_ROUTE_PATTERNS = [/^\/auth(?:\/|$)/, /^\/me(?:\/|$)/];

// Only cache routes that return the same payload for every viewer. Endpoints like
// /reader/stories/:storySlug and review/comment threads are intentionally excluded
// because their responses include viewer-specific state such as follows, ratings,
// ownership, or progress.
const EDGE_CONTENT_ROUTE_PATTERNS = [
  /^\/reader\/home$/,
  /^\/reader\/public-reading-lists$/,
  /^\/reader\/reading-lists\/shared\/[^/]+$/,
  /^\/reader\/rankings$/,
  /^\/reader\/stories$/,
  /^\/reader\/search$/,
];

// No standalone public profile endpoints currently exist in this backend.
const EDGE_PROFILE_ROUTE_PATTERNS: RegExp[] = [];

type RequestLike = {
  method: string;
  raw?: {
    url?: string;
  };
  routeOptions?: {
    url?: string;
  };
  routerPath?: string;
  url?: string;
};

type ReplyLike = {
  header: (name: string, value: string) => unknown;
  statusCode: number;
};

function matchesRoute(pathname: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(pathname));
}

function normalizePathname(url: string | null | undefined) {
  if (!url) {
    return "/";
  }

  let normalizedUrl = url.trim();

  if (!normalizedUrl) {
    return "/";
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalizedUrl) && !normalizedUrl.startsWith("/")) {
    const slashIndex = normalizedUrl.indexOf("/");
    normalizedUrl = slashIndex >= 0 ? normalizedUrl.slice(slashIndex) : `/${normalizedUrl}`;
  }

  const pathname = new URL(normalizedUrl, "http://talestead.local").pathname;

  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

function resolvePathname(request: RequestLike) {
  const candidates = [
    request.raw?.url,
    request.url,
    request.routerPath,
    request.routeOptions?.url,
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const pathname = normalizePathname(candidate);

    if (pathname && pathname !== "/") {
      return pathname;
    }
  }

  return "/";
}

function setNoStore(reply: ReplyLike, options?: { includeCdnHeader?: boolean }) {
  reply.header("Cache-Control", NO_STORE_CACHE_CONTROL);

  if (options?.includeCdnHeader) {
    reply.header("CDN-Cache-Control", NO_STORE_CACHE_CONTROL);
  }
}

export function edgeCacheControlMiddleware(
  request: RequestLike,
  reply: ReplyLike,
  payload: unknown,
  done: (error: Error | null, payload?: unknown) => void,
) {
  const method = request.method.toUpperCase();
  const pathname = resolvePathname(request);
  const isAuthRoute = matchesRoute(pathname, AUTH_ROUTE_PATTERNS);

  console.log(
    "[CACHE DEBUG]",
    method,
    `raw=${request.raw?.url ?? "n/a"}`,
    `url=${request.url ?? "n/a"}`,
    `route=${request.routeOptions?.url ?? request.routerPath ?? "n/a"}`,
    `pathname=${pathname}`,
    `status=${reply.statusCode}`,
  );

  if (method !== "GET" || reply.statusCode < 200 || reply.statusCode >= 300) {
    setNoStore(reply, { includeCdnHeader: isAuthRoute });
    done(null, payload);
    return;
  }

  if (isAuthRoute) {
    setNoStore(reply, { includeCdnHeader: true });
    done(null, payload);
    return;
  }

  if (matchesRoute(pathname, EDGE_PROFILE_ROUTE_PATTERNS)) {
    reply.header("Cache-Control", EDGE_PROFILE_CACHE_CONTROL);
    reply.header("CDN-Cache-Control", EDGE_PROFILE_CACHE_CONTROL);
    done(null, payload);
    return;
  }

  if (matchesRoute(pathname, EDGE_CONTENT_ROUTE_PATTERNS)) {
    reply.header("Cache-Control", EDGE_CONTENT_CACHE_CONTROL);
    reply.header("CDN-Cache-Control", EDGE_CONTENT_CACHE_CONTROL);
    done(null, payload);
    return;
  }

  setNoStore(reply);
  done(null, payload);
}
