/**
 * 仅用于本仓库现有 JSON Schema 比较：删除 Schema 节点的 description 注释，
 * 保留 properties.description 这类真实业务字段。不用于 DTO 或带任意对象 const/default 的通用归一化。
 */
const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

export function omitSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitSchemaDescriptions);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (key === "description") return [];
    if (schemaMaps.has(key) && child !== null && typeof child === "object" && !Array.isArray(child)) {
      return [[key, Object.fromEntries(Object.entries(child).map(([name, schema]) =>
        [name, omitSchemaDescriptions(schema)]))]];
    }
    return [[key, omitSchemaDescriptions(child)]];
  }));
}
