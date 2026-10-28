// Sequential pagination for request tools (Jira, Confluence, etc.).
// Supports startAt (with total) and nextPageToken (with isLast).

export interface PageCursor {
  /** 1-based page index (1, 2, 3...). */
  page: number;
  startAt?: number;
  nextPageToken?: string;
}

export interface PaginateOptions {
  /** Maximum response size in bytes. */
  maxBytes?: number;
}

export const MAX_PAGE_LIMIT = 20;

const CANDIDATE_ARRAY_KEYS = ["issues", "values", "items", "results", "data"];

/**
 * Paginates an API request sequentially following startAt (with total) or nextPageToken (with isLast).
 * Stops when reaching pageLimit, when the API ends, or at the fixed limit of 20 pages.
 * If maxBytes is exceeded, truncates items and sets truncated: true.
 */
export async function paginate<T = unknown>(
  fetchPage: (cursor: PageCursor) => Promise<T>,
  pageLimit: number,
  options?: PaginateOptions,
): Promise<T> {
  const effectiveLimit =
    typeof pageLimit === "number" && pageLimit >= 1
      ? Math.min(Math.floor(pageLimit), MAX_PAGE_LIMIT)
      : 1;

  let currentPage = 1;
  const cursor: PageCursor = { page: 1, startAt: 0 };
  const firstRes = await fetchPage(cursor);

  if (firstRes === null || firstRes === undefined) {
    return firstRes;
  }

  const isHttpResponse =
    typeof firstRes === "object" &&
    firstRes !== null &&
    "status" in firstRes &&
    "ok" in firstRes &&
    ("json" in firstRes || "body" in firstRes);

  const payload: unknown = isHttpResponse
    ? (firstRes as Record<string, unknown>).json
    : firstRes;

  if (!payload || typeof payload !== "object") {
    return firstRes;
  }

  const pRecord = payload as Record<string, unknown>;

  // Find the primary items array
  let itemsKey: string | null = null;
  for (const key of CANDIDATE_ARRAY_KEYS) {
    if (Array.isArray(pRecord[key])) {
      itemsKey = key;
      break;
    }
  }
  if (!itemsKey) {
    for (const [key, val] of Object.entries(pRecord)) {
      if (Array.isArray(val)) {
        itemsKey = key;
        break;
      }
    }
  }

  if (!itemsKey) {
    return firstRes;
  }

  const accumulatedItems: unknown[] = [...(pRecord[itemsKey] as unknown[])];

  // Pagination markers
  const hasStartAt = typeof pRecord.startAt === "number";
  let currentStartAt = typeof pRecord.startAt === "number" ? pRecord.startAt : 0;
  let total = typeof pRecord.total === "number" ? pRecord.total : undefined;
  const isLast = pRecord.isLast === true;

  const hasNextPageToken =
    typeof pRecord.nextPageToken === "string" && pRecord.nextPageToken.length > 0;
  let currentNextPageToken: string | undefined = hasNextPageToken
    ? (pRecord.nextPageToken as string)
    : undefined;

  if (!hasStartAt && !hasNextPageToken) {
    return firstRes;
  }

  const firstItemsCount = (pRecord[itemsKey] as unknown[]).length;
  let apiFinished = false;

  if (hasStartAt) {
    currentStartAt += firstItemsCount;
    if (firstItemsCount === 0 || (total !== undefined && currentStartAt >= total) || isLast) {
      apiFinished = true;
    }
  } else if (hasNextPageToken) {
    if (!currentNextPageToken || isLast || firstItemsCount === 0) {
      apiFinished = true;
    }
  }

  if (apiFinished || effectiveLimit <= 1) {
    return firstRes;
  }

  let isTruncated = false;
  let lastPayload = pRecord;

  while (currentPage < effectiveLimit && !apiFinished) {
    currentPage++;
    const nextCursor: PageCursor = {
      page: currentPage,
      ...(hasStartAt ? { startAt: currentStartAt } : {}),
      ...(hasNextPageToken ? { nextPageToken: currentNextPageToken } : {}),
    };

    const nextRes = await fetchPage(nextCursor);
    if (nextRes === null || nextRes === undefined) {
      break;
    }

    const nextPayload = isHttpResponse
      ? (nextRes as Record<string, unknown>).json
      : nextRes;

    if (!nextPayload || typeof nextPayload !== "object") {
      break;
    }

    const nextRec = nextPayload as Record<string, unknown>;
    lastPayload = nextRec;

    if (itemsKey && Array.isArray(nextRec[itemsKey])) {
      const newItems = nextRec[itemsKey] as unknown[];
      if (newItems.length === 0) {
        apiFinished = true;
        break;
      }
      accumulatedItems.push(...newItems);

      if (options?.maxBytes && options.maxBytes > 0) {
        const currentBytes = Buffer.byteLength(JSON.stringify(accumulatedItems));
        if (currentBytes > options.maxBytes) {
          isTruncated = true;
          while (
            accumulatedItems.length > 1 &&
            Buffer.byteLength(JSON.stringify(accumulatedItems)) > options.maxBytes
          ) {
            accumulatedItems.pop();
          }
          apiFinished = true;
          break;
        }
      }

      if (hasStartAt) {
        currentStartAt += newItems.length;
        if (typeof nextRec.total === "number") total = nextRec.total;
        if ((total !== undefined && currentStartAt >= total) || nextRec.isLast === true) {
          apiFinished = true;
          break;
        }
      }
    } else {
      break;
    }

    if (hasNextPageToken) {
      currentNextPageToken =
        typeof nextRec.nextPageToken === "string" ? nextRec.nextPageToken : undefined;
      if (!currentNextPageToken || nextRec.isLast === true) {
        apiFinished = true;
        break;
      }
    }
  }

  if (isHttpResponse) {
    const origHttp = firstRes as Record<string, unknown>;
    const origJson = (origHttp.json ?? {}) as Record<string, unknown>;
    const mergedJson: Record<string, unknown> = {
      ...origJson,
      ...(itemsKey ? { [itemsKey]: accumulatedItems } : {}),
    };
    if (lastPayload.isLast !== undefined) {
      mergedJson.isLast = lastPayload.isLast;
    }
    if (lastPayload.nextPageToken !== undefined && !lastPayload.isLast) {
      mergedJson.nextPageToken = lastPayload.nextPageToken;
    } else {
      delete mergedJson.nextPageToken;
    }
    if (isTruncated) {
      mergedJson.truncated = true;
    }
    return {
      ...origHttp,
      json: mergedJson,
      truncated: origHttp.truncated === true || isTruncated,
    } as T;
  } else {
    const orig = firstRes as Record<string, unknown>;
    const merged: Record<string, unknown> = {
      ...orig,
      ...(itemsKey ? { [itemsKey]: accumulatedItems } : {}),
    };
    if (lastPayload.isLast !== undefined) {
      merged.isLast = lastPayload.isLast;
    }
    if (lastPayload.nextPageToken !== undefined && !lastPayload.isLast) {
      merged.nextPageToken = lastPayload.nextPageToken;
    } else {
      delete merged.nextPageToken;
    }
    if (isTruncated) {
      merged.truncated = true;
    }
    return merged as T;
  }
}
