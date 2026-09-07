#!/usr/bin/env python3
"""MoneyPal 的私有、单请求 Beancount JSON bridge。stdout 永远只有一个 envelope。"""
import glob, io, json, os, re, sys
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path, PurePosixPath, PureWindowsPath

PROTOCOL_VERSION = 1

class BridgeFailure(ValueError):
    def __init__(self, code, diagnostics=None):
        super().__init__(code)
        self.code = code
        self.diagnostics = diagnostics

def decimal(value):
    value = Decimal(value)
    if not value: return "0"
    text = format(value.normalize(), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text

def amount(number, currency): return {"commodity": currency, "quantity": decimal(number)}
def applied(payload): return {"begin": payload.get("begin"), "end": payload.get("end")}
def in_range(value, payload): return (not payload.get("begin") or value >= payload["begin"]) and (not payload.get("end") or value < payload["end"])
def sums(items):
    total = defaultdict(Decimal)
    for number, currency in items: total[currency] += number
    return [amount(total[k], k) for k in sorted(total) if total[k] != 0]

def sum_amount_rows(rows):
    return sums((Decimal(item["quantity"]), item["commodity"]) for row in rows for item in row["amounts"])

def ledger_path(root):
    """预检布局并按加载顺序返回 main.beancount 与完整 include 图的实际文件列表。"""
    declared_root = Path(root)
    if declared_root.is_symlink() or not declared_root.is_dir(): raise ValueError("invalid_ledger_layout")
    root = declared_root.resolve()
    main = declared_root / "main.beancount"
    accounts = declared_root / "accounts.beancount"
    transactions = declared_root / "transactions"
    if not main.is_file() or not accounts.is_file() or not transactions.is_dir(): raise ValueError("invalid_ledger_layout")
    if not any(re.fullmatch(r"\d{4}\.beancount", child.name) and child.is_file() for child in transactions.iterdir()): raise ValueError("invalid_ledger_layout")
    main_text = main.read_text(encoding="utf8")
    required_includes = {"accounts.beancount", "transactions/*.beancount"}
    included = {match.group(1) for match in re.finditer(r'^\s*include\s+["\']([^"\']+)["\']\s*$', main_text, re.MULTILINE)}
    if not required_includes.issubset(included): raise ValueError("invalid_ledger_layout")
    visited = []
    seen = set()
    def scan(file):
        actual = file.resolve()
        if actual in seen: return
        if root not in actual.parents and actual != root: raise ValueError("invalid_ledger_layout")
        if not actual.is_file(): raise ValueError("invalid_ledger_layout")
        seen.add(actual)
        visited.append(actual)
        for line in actual.read_text(encoding="utf8").splitlines():
            stripped = line.strip()
            if re.match(r"^(plugin|pythonpath)\b", stripped): raise ValueError("invalid_ledger_layout")
            match = re.match(r'^include\s+["\']([^"\']+)["\']\s*$', stripped)
            if match:
                include = match.group(1)
                windows = PureWindowsPath(include)
                posix = PurePosixPath(include)
                if (os.path.isabs(include) or windows.is_absolute() or windows.drive
                    or ".." in windows.parts or ".." in posix.parts): raise ValueError("invalid_ledger_layout")
                matches = glob.glob(str(actual.parent / include))
                if not matches: raise ValueError("invalid_ledger_layout")
                for child in matches: scan(Path(child))
    scan(main)
    return str(main), visited

def load(root):
    main, loaded_files = ledger_path(root)
    from beancount import loader
    from beancount.ops import validation
    # 只读操作不能在正式账本旁创建 pickle cache。
    loader.initialize(False)
    entries, errors, options_map = loader.load_file(main, extra_validations=validation.HARDCORE_VALIDATIONS)
    if errors: raise BridgeFailure("journal_invalid", validation_diagnostics(errors, Path(root).resolve()))
    return entries, options_map, loaded_files

def validation_diagnostics(errors, root):
    diagnostics = []
    for error in errors:
        source = getattr(error, "source", None)
        filename = source.get("filename") if isinstance(source, dict) else None
        lineno = source.get("lineno") if isinstance(source, dict) else None
        relative = None
        if isinstance(filename, str):
            try:
                relative = str(Path(filename).resolve().relative_to(root))
            except ValueError:
                relative = None
        diagnostics.append({
            "severity": "error",
            "location": {"file": relative, "line": lineno if isinstance(lineno, int) and lineno > 0 else None},
            "message": "账本存在 Beancount 语法或会计校验错误。",
            "action": "请根据位置修复该指令后重新验证。",
        })
    return diagnostics

def account_match(account, requested): return not requested or account == requested or account.startswith(requested + ":")
def exposed(key): return key not in {"filename", "lineno"} and not str(key).startswith("__")
def metadata(value):
    if not isinstance(value, dict): return {}
    return {str(key): metadata_value(item) for key, item in sorted(value.items(), key=lambda item: str(item[0])) if exposed(key)}
def metadata_value(value):
    if isinstance(value, Decimal): return decimal(value)
    if isinstance(value, (date,)): return value.isoformat()
    if value is None or isinstance(value, (str, bool)): return value
    if isinstance(value, (list, tuple)): return [metadata_value(item) for item in value]
    if isinstance(value, dict): return metadata(value)
    if hasattr(value, "number") and hasattr(value, "currency"): return amount(value.number, value.currency)
    return str(value)
def cost(value):
    if value is None: return None
    return {"currency": value.currency, "number": decimal(value.number), "date": value.date.isoformat() if value.date else None, "label": value.label}
def posting(entry):
    return {"account": entry.account, "units": amount(entry.units.number, entry.units.currency), "cost": cost(entry.cost), "price": amount(entry.price.number, entry.price.currency) if entry.price else None, "flag": entry.flag, "metadata": metadata(entry.meta)}
def entries_to_transactions(entries, payload):
    from beancount.core.data import Transaction
    result = []
    for entry in entries:
        if not isinstance(entry, Transaction) or not in_range(entry.date.isoformat(), payload): continue
        if payload.get("account") and not any(account_match(p.account, payload["account"]) for p in entry.postings): continue
        if payload.get("text") and payload["text"] not in (entry.payee or "") and payload["text"] not in entry.narration: continue
        result.append({"date": entry.date.isoformat(), "flag": entry.flag, "payee": entry.payee, "narration": entry.narration, "tags": sorted(entry.tags), "links": sorted(entry.links), "metadata": metadata(entry.meta), "postings": [posting(p) for p in entry.postings]})
    return result

def balances(entries, payload, roots=None, sign=1):
    # 余额只消费 account/begin/end；账户筛选把行限制为精确账户及其子账户。
    scoped = {key: value for key, value in payload.items() if key != "text"}
    requested = payload.get("account")
    values = defaultdict(lambda: defaultdict(Decimal))
    for transaction in entries_to_transactions(entries, scoped):
        for posting in transaction["postings"]:
            if roots and posting["account"].split(":", 1)[0] not in roots: continue
            if requested and not account_match(posting["account"], requested): continue
            values[posting["account"]][posting["units"]["commodity"]] += Decimal(posting["units"]["quantity"]) * sign
    accounts = [{"account": name, "amounts": [amount(value, commodity) for commodity, value in sorted(row.items()) if value]} for name, row in sorted(values.items())]
    accounts = [row for row in accounts if row["amounts"]]
    return accounts, sum_amount_rows(accounts)

def balance_boundary(value):
    # 报表日期边界由宿主在调用前校验为绝对日期；直接调用 bridge 时把解析失败
    # 净化为受控错误，而不是落到 internal_error。
    if not value: return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise BridgeFailure("invalid_request")

def report_section(account_balances, root, sign):
    # 资产负债表分区：按固定根账户分类，根外账户与零额账户行一律不出现。
    rows = []
    for account_name in sorted(account_balances):
        if account_name.split(":", 1)[0] != root: continue
        inventory = account_balances[account_name]
        if inventory.is_empty(): continue
        totals = defaultdict(Decimal)
        for position in inventory.get_positions():
            totals[position.units.currency] += position.units.number * sign
        amounts = [amount(value, currency) for currency, value in sorted(totals.items()) if value]
        if amounts: rows.append({"account": account_name, "amounts": amounts})
    return rows, sum_amount_rows(rows)

def balance_sheet_response(entries, options_map, payload):
    # 期末资产负债表：在 [begin, end) 摘要之上执行 Beancount 的 OPEN ON begin（期初）
    # 、CLOSE ON end（结账并清转换）与 CLEAR（损益转入权益）转换，再取 end 前的
    # 各账户余额。报表是截至 end 的累计余额，而不是期间变动；Assets 保持原符号，
    # Liabilities 与 Equity 取反以 normal-balance-positive 展示。
    from beancount.ops import summarize
    from beancount.parser import options as bean_options
    account_types = bean_options.get_account_types(options_map)
    conversion_currency = options_map.get("conversion_currency") or None
    previous_earnings, opening_account, previous_conversions = bean_options.get_previous_accounts(options_map)
    current_earnings, current_conversions = bean_options.get_current_accounts(options_map)
    begin = balance_boundary(payload.get("begin"))
    end = balance_boundary(payload.get("end"))
    if begin is not None:  # OPEN ON begin
        entries, _ = summarize.open(entries, begin, account_types, conversion_currency, previous_earnings, opening_account, previous_conversions)
    if end is not None:    # CLOSE ON end + CLEAR
        entries, _ = summarize.close(entries, end, conversion_currency, current_conversions)
        entries, _ = summarize.clear(entries, end, account_types, current_earnings)
    balances, _ = summarize.balance_by_account(entries, end)
    assets, asset_total = report_section(balances, account_types.assets, 1)
    liabilities, liability_total = report_section(balances, account_types.liabilities, -1)
    equity, equity_total = report_section(balances, account_types.equity, -1)
    return {
        "range": applied(payload),
        "assets": {"accounts": assets, "totals": asset_total},
        "liabilities": {"accounts": liabilities, "totals": liability_total},
        "equity": {"accounts": equity, "totals": equity_total},
        "totals": {"assets": asset_total, "liabilitiesAndEquity": sums((Decimal(item["quantity"]), item["commodity"]) for item in liability_total + equity_total)},
    }

def escape_narration(value):
    return value.replace("\\", "\\\\").replace('"', '\\"')

def build_candidate_text(transactions):
    """把候选输入 {date, description, postings[{account, amount?}]} 组装为 Beancount 语法的纯文本。"""
    blocks = []
    for item in transactions:
        date_str = item.get("date")
        description = item.get("description")
        postings = item.get("postings")
        if not isinstance(date_str, str) or not isinstance(description, str) or not isinstance(postings, list) or not postings:
            raise BridgeFailure("invalid_transaction_batch")
        try:
            date.fromisoformat(date_str)
        except ValueError:
            raise BridgeFailure("invalid_transaction_batch")
        if len(postings) < 2 or sum(1 for posting in postings if not posting.get("amount")) > 1:
            raise BridgeFailure("invalid_transaction_batch")
        lines = [f'{date_str} * "{escape_narration(description)}"']
        for posting in postings:
            account = posting.get("account")
            amount = posting.get("amount")
            if not isinstance(account, str) or not account.strip():
                raise BridgeFailure("invalid_transaction_batch")
            account = account.strip()
            if amount is None or amount == "":
                if amount is not None and not isinstance(amount, str):
                    raise BridgeFailure("invalid_transaction_batch")
                lines.append(f"  {account}")
            else:
                if not isinstance(amount, str) or not amount.strip():
                    raise BridgeFailure("invalid_transaction_batch")
                lines.append(f"  {account}  {amount.strip()}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)

def parse_and_book(text, options_map):
    """解析候选文本并按正式账本的 options 完成 booking；任何候选自身问题都是 invalid_transaction_batch。"""
    from beancount.parser import booking, parser
    parsed, parse_errors, _ = parser.parse_string(text)
    if parse_errors:
        raise BridgeFailure("invalid_transaction_batch")
    booked, booking_errors = booking.book(parsed, options_map)
    if booking_errors:
        raise BridgeFailure("invalid_transaction_batch")
    for entry in booked:
        currencies = {posting.units.currency for posting in entry.postings}
        if len(currencies) != 1:
            raise BridgeFailure("invalid_transaction_batch")
    return booked

def open_directives(entries):
    from beancount.core.data import Close, Open
    opens, closes = {}, {}
    for entry in entries:
        if isinstance(entry, Open):
            opens.setdefault(entry.account, entry)
        elif isinstance(entry, Close):
            closes[entry.account] = entry
    return opens, closes

def check_candidate_accounts(entries, formal_entries):
    """候选账户必须大小写精确声明、在交易日期开放、且商品未被 Open 限定排除。"""
    opens, closes = open_directives(formal_entries)
    for entry in entries:
        for posting in entry.postings:
            declared = opens.get(posting.account)
            if declared is None:
                raise BridgeFailure("undeclared_account")
            if entry.date < declared.date:
                raise BridgeFailure("invalid_transaction_batch")
            closed = closes.get(posting.account)
            if closed is not None and entry.date >= closed.date:
                raise BridgeFailure("invalid_transaction_batch")
            if declared.currencies and posting.units.currency not in declared.currencies:
                raise BridgeFailure("invalid_transaction_batch")

def validate_combined(entries, options_map):
    """正式账本已独立通过强化校验；组合后的任何校验失败都归因于候选。"""
    from beancount.ops import validation
    if validation.validate(entries, options_map, extra_validations=validation.HARDCORE_VALIDATIONS):
        raise BridgeFailure("invalid_transaction_batch")

def canonical_transaction_texts(entries):
    from beancount.parser import printer
    texts = []
    for entry in entries:
        buffer = io.StringIO()
        printer.print_entry(entry, file=buffer)
        texts.append(buffer.getvalue().rstrip("\n") + "\n")
    return texts

def summarize_candidates(entries):
    totals = defaultdict(lambda: defaultdict(Decimal))
    for entry in entries:
        for posting in entry.postings:
            root = posting.account.split(":", 1)[0]
            if root == "Income":
                totals[posting.units.currency]["income"] -= posting.units.number
            elif root == "Expenses":
                totals[posting.units.currency]["expense"] += posting.units.number
    rows = []
    for currency in sorted(totals):
        income = totals[currency]["income"]
        expense = totals[currency]["expense"]
        rows.append({"commodity": currency, "income": decimal(income), "expenses": decimal(expense), "netIncome": decimal(income - expense)})
    return rows

def account_root(account):
    return account.split(":", 1)[0]

def transaction_size(entry):
    totals = defaultdict(Decimal)
    for posting in entry.postings:
        totals[posting.units.currency] += abs(posting.units.number)
    return {currency: totals[currency] / 2 for currency in totals}

def funding_accounts(entry):
    return sorted({posting.account for posting in entry.postings if account_root(posting.account) in {"Assets", "Liabilities", "Equity"}})

def expense_accounts(entry):
    return sorted({posting.account for posting in entry.postings if account_root(posting.account) == "Expenses"})

def duplicate_reasons(existing, size, funding, expenses, narration):
    """资金账户集合大小写精确匹配且交易规模一致时，返回命中的提醒原因。"""
    if transaction_size(existing) != size or funding_accounts(existing) != funding:
        return []
    reasons = []
    if (existing.payee is None or existing.payee == "") and existing.narration == narration:
        reasons.append("same_payee_and_narration")
    if expenses and expense_accounts(existing) == expenses:
        reasons.append("same_expense_accounts")
    return reasons

def duplicate_warnings(entries, candidates):
    """候选日期前后 3 天（含首尾），同时比较正式账本与同批较早候选；每对只提醒一次。"""
    from beancount.core.data import Transaction
    warnings = []
    for index, candidate in enumerate(candidates):
        begin = candidate.date - timedelta(days=3)
        end = candidate.date + timedelta(days=4)
        size = transaction_size(candidate)
        funding = funding_accounts(candidate)
        expenses = expense_accounts(candidate)
        narration = candidate.narration
        comparisons = [
            ("ledger", None, existing)
            for existing in entries
            if isinstance(existing, Transaction)
        ] + [
            ("batch", earlier_index, candidates[earlier_index])
            for earlier_index in range(index)
        ]
        for source, matched_index, existing in comparisons:
            if not (begin <= existing.date < end): continue
            reasons = duplicate_reasons(existing, size, funding, expenses, narration)
            if reasons:
                warnings.append({
                    "candidateIndex": index,
                    "source": source,
                    "matchedCandidateIndex": matched_index,
                    "existingDate": existing.date.isoformat(),
                    "existingPayee": existing.payee,
                    "existingNarration": existing.narration,
                    "reasons": reasons,
                })
    return warnings

def preview_response(entries, options_map, loaded_files, payload):
    candidates = parse_and_book(build_candidate_text(payload.get("transactions")), options_map)
    check_candidate_accounts(candidates, entries)
    validate_combined(entries + candidates, options_map)
    texts = canonical_transaction_texts(candidates)
    return {
        "validation": "passed",
        "transactions": texts,
        "transactionText": "\n".join(texts),
        "amountSummary": summarize_candidates(candidates),
        "duplicateWarnings": duplicate_warnings(entries, candidates),
        # 内部字段：TypeScript 写入 module 依据本 op 实际加载的 include 图计算快照，不进入公开预览 DTO。
        "loadedFiles": [str(file) for file in loaded_files],
    }

def validate_candidates_response(entries, options_map, loaded_files, payload):
    text = payload.get("transactionText")
    if not isinstance(text, str) or not text.strip():
        raise BridgeFailure("invalid_transaction_batch")
    candidates = parse_and_book(text, options_map)
    check_candidate_accounts(candidates, entries)
    validate_combined(entries + candidates, options_map)
    # 内部字段：提交时重新校验的加载文件集合，供 TypeScript 比对 include 集合是否变化。
    return {"valid": True, "loadedFiles": [str(file) for file in loaded_files]}

def handle(operation, payload):
    if operation == "probe":
        import beancount, beanquery
        return {"pythonVersion": sys.version.split()[0], "beancountVersion": beancount.__version__, "beanqueryVersion": beanquery.__version__, "beancountAvailable": True}
    entries, options_map, loaded_files = load(payload["ledgerDirectory"])
    if operation == "validate": return {"valid": True}
    if operation == "list_accounts":
        from beancount.core.data import Open
        return {"accounts": sorted({entry.account for entry in entries if isinstance(entry, Open)})}
    if operation == "register":
        transactions = entries_to_transactions(entries, payload)
        limit = payload.get("limit")
        return {"range": applied(payload), "truncated": bool(limit and len(transactions) > limit), "transactions": transactions[:limit] if limit else transactions}
    if operation == "balance":
        accounts, totals = balances(entries, payload)
        return {"range": applied(payload), "accounts": accounts, "totals": totals}
    if operation == "income_statement":
        # 期间损益表按 [begin, end) 的 posting 聚合：行为等价于 Beancount OPEN/CLOSE
        # 的期间语义（期初不含、期末截断、账户平铺），不合成递归父节点。
        income_accounts, income = balances(entries, payload, {"Income"}, -1)
        expense_rows, expense = balances(entries, payload, {"Expenses"})
        net = sums([(Decimal(a["quantity"]), a["commodity"]) for a in income] + [(-Decimal(a["quantity"]), a["commodity"]) for a in expense])
        return {"range": applied(payload), "income": {"accounts": income_accounts, "totals": income}, "expenses": {"accounts": expense_rows, "totals": expense}, "netIncome": net}
    if operation == "balance_sheet":
        return balance_sheet_response(entries, options_map, payload)
    if operation == "preview":
        return preview_response(entries, options_map, loaded_files, payload)
    if operation == "validate_candidates":
        return validate_candidates_response(entries, options_map, loaded_files, payload)
    raise BridgeFailure("invalid_request")

def runtime_versions():
    def installed(distribution):
        try:
            return version(distribution)
        except PackageNotFoundError:
            return None
    return {"python": sys.version.split()[0], "beancount": installed("beancount"), "beanquery": installed("beanquery")}

def main():
    # 发行版元数据读取不会导入 Beancount；因此每个响应都能携带运行时信息，
    # 同时布局信任边界仍在任何 Beancount 模块导入之前完成。
    runtime = runtime_versions()
    try:
        request = json.load(sys.stdin)
        if request.get("protocolVersion") != PROTOCOL_VERSION: raise RuntimeError("protocol")
        # 信任边界预检必须在导入 Beancount 之前完成；合法请求随后在
        # 同一子进程中取得版本并完成领域操作，不另起探测进程。
        if request.get("operation") != "probe": ledger_path(request["payload"]["ledgerDirectory"])
        result = handle(request["operation"], request["payload"])
        response = {"protocolVersion": PROTOCOL_VERSION, "runtime": runtime, "ok": True, "result": result}
    except BridgeFailure as error:
        response = {"protocolVersion": PROTOCOL_VERSION, "runtime": runtime, "ok": False, "error": {"code": error.code, **({"diagnostics": error.diagnostics} if error.diagnostics else {})}}
    except ValueError as error:
        code = str(error)
        response = {"protocolVersion": PROTOCOL_VERSION, "runtime": runtime, "ok": False, "error": {"code": code if code in {"invalid_ledger_layout", "journal_invalid", "invalid_transaction_batch", "undeclared_account", "invalid_request"} else "internal_error"}}
    except Exception:
        response = {"protocolVersion": PROTOCOL_VERSION, "runtime": runtime, "ok": False, "error": {"code": "internal_error"}}
    print(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
if __name__ == "__main__": main()
