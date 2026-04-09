const version = import.meta.env.VITE_APP_VERSION || "0.0.0-dev";
const commit = import.meta.env.VITE_GIT_SHA || "dev";
const builtAt = import.meta.env.VITE_BUILD_TIME || "";

function formatBuiltAt(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace(".000Z", "Z");
}

export const BUILD_INFO = {
  version,
  commit,
  builtAt,
  label: commit === "dev" ? `v${version}` : `v${version} (${commit.slice(0, 7)})`,
  tooltip: [
    version,
    commit !== "dev" ? `commit ${commit}` : null,
    builtAt ? formatBuiltAt(builtAt) : null,
  ]
    .filter(Boolean)
    .join("\n"),
} as const;
