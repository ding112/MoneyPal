import { createLedgerEngine } from "./finance/engine.js";
import { FinanceError } from "./finance/errors.js";
import type { AccountAmounts, BalanceResult, MoneyAmount } from "./finance/types.js";
import { dayAfter } from "./finance/date.js";

export { dayAfter };

export interface BalanceAccount { account: string; amounts: MoneyAmount[]; }
export interface BalanceGroup { accounts: BalanceAccount[]; totals: MoneyAmount[]; }
export interface BalanceSnapshot { asOf: string; assets: BalanceGroup; liabilities: BalanceGroup; }

/** 将账本引擎的稳定余额 DTO 收敛为抽屉所需的两个根账户分组。 */
export async function readBalanceSnapshot(workspace: string, asOf: string, signal?: AbortSignal): Promise<BalanceSnapshot> {
  let end: string;
  try {
    end = dayAfter(asOf, "余额日期");
  } catch {
    throw new FinanceError("journal_invalid", "余额日期必须使用 YYYY-MM-DD 格式。");
  }
  const balance = await createLedgerEngine({ ledgerWorkspace: workspace }).getBalance({ end }, signal);
  return snapshotFromBalance(asOf, balance);
}

/** 抽屉只依赖领域 DTO，绝不读取 Python bridge 或底层账本引擎的私有形状。 */
export function snapshotFromBalance(asOf: string, balance: BalanceResult): BalanceSnapshot {
  return {
    asOf,
    assets: group(balance.accounts, "Assets"),
    liabilities: group(balance.accounts, "Liabilities"),
  };
}

function group(rows: AccountAmounts[], root: "Assets" | "Liabilities"): BalanceGroup {
  const accounts = rows
    .filter((row) => row.account === root || row.account.startsWith(`${root}:`))
    .map((row) => ({ account: row.account, amounts: row.amounts }))
    .sort((left, right) => left.account < right.account ? -1 : left.account > right.account ? 1 : 0);
  return { accounts, totals: sum(accounts.flatMap((account) => account.amounts)) };
}

function sum(amounts: MoneyAmount[]): MoneyAmount[] {
  const totals = new Map<string, { mantissa: bigint; places: number }>();
  for (const amount of amounts) {
    const parsed = decimalParts(amount.quantity);
    const previous = totals.get(amount.commodity) ?? { mantissa: 0n, places: 0 };
    const places = Math.max(previous.places, parsed.places);
    totals.set(amount.commodity, {
      mantissa: previous.mantissa * 10n ** BigInt(places - previous.places) + parsed.mantissa * 10n ** BigInt(places - parsed.places),
      places,
    });
  }
  return [...totals]
    .filter(([, value]) => value.mantissa !== 0n)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([commodity, value]) => ({ commodity, quantity: decimalString(value.mantissa, value.places) }));
}

function decimalParts(value: string): { mantissa: bigint; places: number } {
  if (!/^-?\d+(?:\.\d+)?$/u.test(value)) throw new FinanceError("journal_invalid", "账本引擎返回了无法识别的余额数据。");
  const negative = value.startsWith("-");
  const [integer, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  return { mantissa: (negative ? -1n : 1n) * BigInt(`${integer}${fraction}`), places: fraction.length };
}

function decimalString(mantissa: bigint, places: number): string {
  const negative = mantissa < 0n;
  const digits = (negative ? -mantissa : mantissa).toString().padStart(places + 1, "0");
  return `${negative ? "-" : ""}${places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits}`;
}
