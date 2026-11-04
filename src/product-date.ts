import { readAbsoluteDate } from "./core/dist/src/contracts.js";

/** 余额截止日期转换为账本引擎的排他边界。 */
export function dayAfter(value: unknown, label = "日期"): string {
  const date = readAbsoluteDate(value, label);
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}
