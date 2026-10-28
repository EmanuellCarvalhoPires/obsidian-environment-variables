// Grouping of the MCP packages installed through AI Ecosystem: the app card a package's service belongs to.

/** The fields of an installed MCP package that its MCP group and app card need. */
export interface McpCatalogEntry {
  id: string;
  name: string;
  /** Notes with this tag (and its subtags) belong to the package, e.g. api/app/assets. */
  tag: string;
  /** Id of a bundled default logo (see defaultLogos.ts), or unknown for a generic icon. */
  logo: string;
  /** The service_tag its tools pick an instance through (e.g. atlassian/instance), if any. */
  serviceTag?: string;
}

/**
 * Apps a package's `serviceTag` groups it under (e.g. every Atlassian package shares the
 * "atlassian/instance" service, so they all belong to the "Atlassian" app card). Keyed by
 * the service prefix of that tag.
 */
const SERVICE_APPS: Record<string, { name: string; logo: string }> = {
  atlassian: { name: "Atlassian", logo: "atlassian" },
  // Bitbucket has its own service (bitbucket/workspace) but is an Atlassian app too.
  bitbucket: { name: "Atlassian", logo: "atlassian" },
};

/** The two-level app (name + default logo id) a package should be grouped under, if any. */
export function appForEntry(entry: Pick<McpCatalogEntry, "serviceTag">): { name: string; logo: string } | undefined {
  if (!entry.serviceTag) return undefined;
  const service = entry.serviceTag.split("/")[0];
  return SERVICE_APPS[service];
}
