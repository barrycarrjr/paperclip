/** POSIX logical paths only. These helpers never interpret host filesystem paths. */
function normalize(value: string): string {
  if (!value) return ".";
  const absolute = value.startsWith("/");
  const trailing = value.endsWith("/");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push(part);
    } else parts.push(part);
  }
  let result = parts.join("/");
  if (!result && !absolute) result = ".";
  if (result && trailing) result += "/";
  return (absolute ? "/" : "") + result;
}

export function logicalDirname(value: string): string {
  if (!value) return ".";
  let end = value.length - 1;
  while (end > 0 && value[end] === "/") end -= 1;
  const separator = value.lastIndexOf("/", end);
  if (separator < 0) return ".";
  if (separator === 0) return "/";
  if (separator === 1 && value.startsWith("/")) return "//";
  return value.slice(0, separator);
}

export function logicalJoin(...values: string[]): string {
  return normalize(values.filter(Boolean).join("/"));
}

export function logicalExtname(value: string): string {
  const basename = value.replace(/\/+$/, "").split("/").at(-1) ?? "";
  const dot = basename.lastIndexOf(".");
  return dot <= 0 || basename === ".." ? "" : basename.slice(dot);
}

function resolve(value: string, basePath: string): string {
  // An explicit logical root replaces Node's implicit process.cwd().
  const result = normalize(value.startsWith("/") ? value : `${basePath}/${value}`);
  return result === "/" ? result : result.replace(/\/+$/, "");
}

export function logicalRelative(from: string, to: string, basePath: string): string {
  const base = resolve(basePath, "/");
  const source = resolve(from, base).split("/").filter(Boolean);
  const target = resolve(to, base).split("/").filter(Boolean);
  let common = 0;
  while (common < source.length && common < target.length && source[common] === target[common]) common += 1;
  return [...source.slice(common).map(() => ".."), ...target.slice(common)].join("/");
}
