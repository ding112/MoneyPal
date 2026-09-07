# MoneyPal 当前财务能力的 Beancount v3 语义映射

调研日期：2026-09-02  
范围：仅核对当前 MoneyPal 已使用的能力，不决定后续产品契约或实现方案。

## 结论

Beancount v3 与官方 beanquery 足以承载 MoneyPal 当前的读取、整本校验和单商品普通交易，但不是 hledger CLI 的逐命令替换品。

- 流水、余额和账户列表有直接的数据模型或查询表达，但返回的是 Beancount 的 `Transaction`、`Posting`、`Inventory` 等类型，不是当前 hledger JSON；MoneyPal 必须拥有稳定的结构化输出层。
- 损益表和资产负债表可以用 beanquery 的日期转换与聚合表达，但 v3 没有当前 `incomestatement -O json`、`balancesheet -O json` 那样直接返回完整报表树的官方命令；树形、分组、符号与合计属于 MoneyPal 的适配职责。
- 整本校验和 include 文件集合有可靠的官方入口。候选交易与正式账本的叠加校验没有 hledger 多个 `-f` 的直接等价物，需要临时入口文件或 Python 内组合加载/校验。
- 默认校验不做模糊重复交易检测；现有 ±7 日和指纹规则必须继续由 MoneyPal 实现。
- Beancount 的账户、商品、交易文本和金额语法都比当前 MoneyPal 的 hledger 渲染约束更严格。中文账户叶节点需要机械前缀；交易描述必须是字符串；交易要带 flag；数字不能写成 `.5`；商品不能直接写 `$` 或 `€`。
- Beancount 原生支持多商品和 lot。即便 MoneyPal 写入继续限制为单商品，读取余额的领域结果也必须明确是保留多商品 inventory，还是把超出范围视为错误；不能假设一个账户只有一个数值。

## 当前基线

本报告以现有代码而不是 hledger 的全部能力为比较基线：

- [`src/finance/hledger.ts`](../../src/finance/hledger.ts) 封装余额、流水、损益表、资产负债表、声明账户、整本校验、候选 journal 叠加校验、已加载文件集合和交易 JSON。
- [`src/finance/write.ts`](../../src/finance/write.ts) 在 preview/commit 前检查账户声明、候选交易、单商品约束与疑似重复交易，并快照所有已加载文件。
- [`src/finance/journal.ts`](../../src/finance/journal.ts) 生成 hledger 交易，允许最多一个 posting 省略金额。
- [`src/balance.ts`](../../src/balance.ts) 把 hledger 余额 JSON 适配为精确十进制、多商品余额，并用查询日次日作为排他结束日。

Beancount v3 自 2024 年 6 月起是稳定分支；旧的 v2 报告工具已从核心包移走，因此本报告只把 Beancount 核心与独立的官方 beanquery 当作目标运行时。[Beancount 官方仓库](https://github.com/beancount/beancount)；[旧报告文档的 v3 提示](https://beancount.github.io/docs/running_beancount_and_generating_reports/)

## 能力等价表

| 当前 MoneyPal 能力 | Beancount v3 / beanquery 表达 | 等价程度 | MoneyPal 仍需负责 |
|---|---|---|---|
| 流水 / register | 从 postings 表选择 `date`、交易字段、`account`、`position`；beanquery 文档给出 `SELECT ... balance WHERE account ~ ...` 和 `JOURNAL` 捷径 | 需适配 | 精确账户/子树匹配、稳定 JSON、分页/排序、累计余额口径 |
| 余额 | `SELECT account, sum(position) ... GROUP BY account` 或 `BALANCES` | 需适配 | `Inventory` 多商品序列化、账户树、合计与日期口径 |
| 损益表 | `OPEN ON begin CLOSE ON end` 后筛选 Income/Expenses 并按账户聚合 | 需适配 | 报表树、标题、符号、分组与稳定 schema |
| 资产负债表 | `OPEN ON begin CLOSE ON end CLEAR` 后筛选非 Income/Expenses 并聚合 | 需适配 | 报表树、权益结转展示、合计与稳定 schema |
| 声明账户 | 读取 `Open` directives；beanquery 的 accounts 表暴露账户及 open/close | 接近直接等价 | “声明”必须定义为显式 `open`，不应混入父级名称或仅被引用的非法账户 |
| 整本校验 | `bean-check <main-file>` 或 Python `loader.load_file()` | 直接等价 | 把官方错误转换为现有错误码/诊断结构 |
| 候选交易校验 | 无多入口 `-f` 等价；需建立含正式 include 图与候选文件的临时顶层入口，或在 Python 中组合后调用校验 | 无直接等价 | 临时组合、顶层 option 保真、错误归属和清理 |
| include 文件集合 | `loader.load_file()` 返回的 `options_map["include"]` 是已访问文件的排序集合，包含顶层文件 | 直接等价 | 路径标准化及快照/漂移检测 |
| 重复检测 | 默认 validation 不检查相似或重复交易；交易 `id` 是内容哈希 | 无直接等价 | 保留当前 ±7 日候选搜索与业务指纹 |
| 一个 posting 省略金额 | Beancount 插值器允许一个 posting 缺失 units，并自动补齐 | 接近直接等价 | 继续限制最多一个；多商品时自动补出多个 posting 的行为要受产品范围约束 |
| 交易渲染 | 官方 `EntryPrinter` 生成规范 Beancount 文本 | 需改写 | flag、字符串转义、账户映射、Decimal/商品格式及末尾换行 |

流水、余额、日期转换和 `PRINT` 的官方查询示例见 [Beancount Query Language](https://beancount.github.io/docs/beancount_query_language/)；当前 beanquery 的 Beancount 数据源字段与加载方式见 [`beanquery/sources/beancount.py`](https://github.com/beancount/beanquery/blob/master/beanquery/sources/beancount.py)。

## 逐项语义核对

### 1. 流水

beanquery 的 Beancount 数据源把每个 posting 暴露为一行，并附带父交易的日期、payee、narration、账户、number、currency、position、weight、balance 和 entry 等字段；transactions 与 entries 也有独立表。[当前 Beancount 数据源实现](https://github.com/beancount/beanquery/blob/master/beanquery/sources/beancount.py)

官方查询文档的典型流水表达为：

```sql
SELECT date, account, position, balance
WHERE account ~ 'Assets:Checking'
```

也可使用 `JOURNAL <account-regexp>` 捷径。[Beancount Query Language：JOURNAL 与 posting 字段](https://beancount.github.io/docs/beancount_query_language/)

这不是当前 `hledger register -O json` 的结构等价：

- `account ~` 是正则搜索。MoneyPal 如果要保留“精确账户或账户子树”语义，必须转义用户输入并显式锚定边界，不能直接把账户名当正则。
- beanquery 行含 Beancount 原生 Decimal、Position/Inventory 等对象；CLI 当前渲染器只提供文本、CSV 和 Beancount 格式，没有 JSON 渲染器。[beanquery render 目录](https://github.com/beancount/beanquery/tree/master/beanquery/render)
- 因而最稳妥的语义边界是 MoneyPal 从 Python API 取得类型化行，再输出自有 JSON；这是基于官方接口能力的实现推论，不是 Beancount 规定的产品 schema。

### 2. 余额

官方查询模型用 `sum(position)` 聚合 posting。返回值是 `Inventory`，可以包含多个商品和多个 lot，而不是单个数字；`units()` 可丢弃成本信息后聚合 units。[Beancount Query Language：positions、inventories 与 BALANCES](https://beancount.github.io/docs/beancount_query_language/)

典型账户余额可表达为：

```sql
SELECT account, sum(position)
GROUP BY account
ORDER BY account
```

`BALANCES` 是同类报表捷径。语义上可以替代当前余额读取，但不能沿用“一个账户一个 amount”的假设。现有 [`src/balance.ts`](../../src/balance.ts) 已经能容纳多条商品金额，这一点应保留；Decimal 应作为精确十进制字符串越过 Python/Node 边界，避免转成 IEEE-754 number。后一句属于 MoneyPal 接口需要自行定义的契约。

### 3. 损益表

官方示例用 `OPEN ON` 和 `CLOSE ON` 将查询窗口外的交易转换后，再筛选 Income/Expenses：

```sql
SELECT account, sum(position)
FROM OPEN ON 2026-01-01 CLOSE ON 2027-01-01
WHERE account ~ '^(Income|Expenses)(:|$)'
GROUP BY account
ORDER BY account
```

`OPEN ON` 会把开始日前的资产负债结转，并清除开始日前的 Income/Expenses；`CLOSE ON` 排除结束日及以后的条目。[Beancount Query Language：OPEN、CLOSE 与 income statement 示例](https://beancount.github.io/docs/beancount_query_language/)

这能得到损益表的账户行，却不会直接给出 hledger 当前 JSON 的层级、分区和合计。MoneyPal 必须自行把行组织为稳定报表结构，并明确定义收入/费用的显示符号。

### 4. 资产负债表

官方示例在同一日期转换后使用 `CLEAR`：它把当前 Income/Expenses 余额转入配置的当期收益权益账户，然后对非损益账户聚合。[Beancount Query Language：CLEAR 与 balance sheet 示例](https://beancount.github.io/docs/beancount_query_language/)

```sql
SELECT account, sum(position)
FROM OPEN ON 2026-01-01 CLOSE ON 2027-01-01 CLEAR
WHERE NOT account ~ '^(Income|Expenses)(:|$)'
GROUP BY account
ORDER BY account
```

Beancount 的五个根账户名和结转账户名可由 option 改写，并非永远固定为英文默认值。[当前 options 定义](https://github.com/beancount/beancount/blob/master/beancount/parser/options.py) 因而筛选与分组应读取 `options_map`，不能把根名硬编码为协议事实。

同损益表一样，这只提供报表数据基础，不直接提供 MoneyPal 所需的完整资产负债表树或 JSON。

### 5. 账户声明、字符与大小写

Beancount 把账户生命周期建模为带日期的 `open` / `close`。posting 引用的账户必须存在有效的 `open`，且日期不能早于 open、不能晚于 close；`open` 可附允许的商品列表和 booking method。[Beancount Language Syntax：Open](https://beancount.github.io/docs/beancount_language_syntax/)

```beancount
2026-01-01 open Assets:A支付宝 CNY
2026-01-01 open Expenses:F家庭:F食品 CNY
```

当前账户组件正则为：根类型必须匹配配置的根名；根名后的每个组件都必须以 Unicode 大写字母或数字开头，剩余字符允许 Unicode 字母、数字与 `-`。[`beancount/core/account.py`](https://github.com/beancount/beancount/blob/master/beancount/core/account.py)；[parser grammar](https://github.com/beancount/beancount/blob/master/beancount/parser/grammar.py)

因此：

- `Assets:支付宝` 不合法，因为汉字属于 Unicode Letter Other，而不是 uppercase letter；`Assets:A支付宝` 合法。
- 各组件不允许空格或下划线。
- 账户标识是精确字符串，active-account 校验用精确成员关系；大小写不同就是不同账户，不应继承 [`src/balance.ts`](../../src/balance.ts) 对根名的大小写宽松匹配。[当前 validation 实现](https://github.com/beancount/beancount/blob/master/beancount/ops/validation.py)

“声明账户”应映射为显式 `Open` directive，而不是所有出现过的账户字符串。当前 beanquery accounts 表从 open/close 指令建立账户记录。[当前 Beancount 数据源实现](https://github.com/beancount/beanquery/blob/master/beanquery/sources/beancount.py)

### 6. `open` 与 `commodity`

`open` 对会出现在 posting 中的账户是必需的；其可选商品列表还能限制该账户允许出现的 units 商品。`commodity` 指令则是可选的，主要用于为商品附加元数据；同一商品重复声明会由默认校验报告错误。[Beancount Language Syntax：Open 与 Commodity](https://beancount.github.io/docs/beancount_language_syntax/)；[默认 validation 集合](https://github.com/beancount/beancount/blob/master/beancount/ops/validation.py)

因此新工作区至少要为所有可写账户生成有日期的 `open`。是否为 `CNY` 等商品生成 `commodity` 是格式/元数据选择，不是交易合法性的前置条件；如果生成，必须确保唯一。

### 7. 整本校验

官方 `loader.load_file(filename)` 返回 `(entries, errors, options_map)`，执行解析、booking/插值、插件和默认 validation；`bean-check` 在此基础上运行更完整校验，并根据是否存在 errors 返回非零状态。[loader 源码](https://github.com/beancount/beancount/blob/master/beancount/loader.py)；[bean-check 源码](https://github.com/beancount/beancount/blob/master/beancount/scripts/check.py)

当前 `bean-check` 只接受一个入口文件。其 `--json` 输出错误消息、文件名和行号，可作为 MoneyPal 错误适配的输入，但不能直接视为现有错误 schema。[bean-check 源码](https://github.com/beancount/beancount/blob/master/beancount/scripts/check.py)

默认 validation 包含：账户 open/close 与有效期、open 商品约束、交易平衡、重复 balance/commodity 指令、路径等检查。[默认 validation 集合](https://github.com/beancount/beancount/blob/master/beancount/ops/validation.py)

### 8. 候选交易校验

这里没有 hledger “正式主账本 `-f` + 候选文件 `-f`”的命令行等价物。`bean-check` 和 `loader.load_file()` 都以一个顶层文件为入口。[bean-check 源码](https://github.com/beancount/beancount/blob/master/beancount/scripts/check.py)；[loader 源码](https://github.com/beancount/beancount/blob/master/beancount/loader.py)

可行但需后续设计/原型验证的两种边界是：

1. 为一次校验生成临时顶层文件，使其 include 正式文件集合和候选文件，然后执行 `bean-check`。
2. 在 Python bridge 中加载/解析候选项，与正式 entries 组合后调用官方校验函数。

第一种不能天真地只写 `include "原 main"`：loader 对 included 文件的普通 options 不做完整合并，顶层 options 可能改变账户根名、结转账户、插件等语义。[loader 的递归加载与 options 合并实现](https://github.com/beancount/beancount/blob/master/beancount/loader.py) 第二种则需要 MoneyPal 显式编排解析、排序、booking/插值与 validation，不能只拼接两个已验证结果。以上是约束说明，不在本票据选择方案。

### 9. include 与已加载文件集合

`include` 支持相对路径和 glob；相对路径以包含它的文件为基准递归解析。无匹配、读取失败以及同一文件被再次加载（包括循环 include）都会形成错误。[loader 的 include 处理](https://github.com/beancount/beancount/blob/master/beancount/loader.py)

加载完成后，`options_map["include"]` 被设为所有实际访问文件的排序列表，包含顶层入口文件；loader 还基于同一集合计算 `input_hash`。[loader 源码](https://github.com/beancount/beancount/blob/master/beancount/loader.py) 这与当前 `hledger files` 的用途直接对应，可用于 preview 时建立完整账本快照。MoneyPal 仍要定义跨平台路径规范化和如何呈现新增/删除文件。

### 10. 重复检测

Beancount 默认 validation 列表没有“重复交易”或“相似交易”检查。[默认 validation 集合](https://github.com/beancount/beancount/blob/master/beancount/ops/validation.py)

beanquery 暴露的交易 `id` 是由条目内容派生的稳定哈希；条目内容变化时它也会变化。[Beancount Query Language：id](https://beancount.github.io/docs/beancount_query_language/) 它适合关联同一交易的多条 posting，不等价于当前 MoneyPal 的业务重复指纹，更无法替代“日期相差不超过 7 天且金额/资金账户/描述或费用账户匹配”的启发式规则。

因此重复检测是明确的“无直接等价物”：查询候选窗口可由 beanquery 完成，最终比较仍由 MoneyPal 完成。

### 11. 省略金额与交易平衡

Beancount 允许一个 posting 省略 units，并由插值器补齐。若其他 posting 涉及多个商品，一个省略行可能展开成每种商品一条自动 posting，而不只是补出一个金额。[Beancount Language Syntax：Elided Amounts](https://beancount.github.io/docs/beancount_language_syntax/)

Beancount 的交易平衡依据 posting 的 weight，不总是 units 的简单代数和：有 cost 时使用 cost，有 price 时按对应规则计算。[Beancount Language Syntax：How Does It Work?](https://beancount.github.io/docs/beancount_language_syntax/)

所以当前“最多一个 posting 不填金额”的输入约束可保留，但候选校验不能由 TypeScript 自己按 units 求和替代官方 booking/插值/平衡。MoneyPal v1 若只接受普通单商品交易，应在进入渲染器前明确拒绝 cost、price 与多商品写入；这是范围约束，不是 Beancount 限制。

### 12. 日期边界

Beancount 日期是 ISO `YYYY-MM-DD`。beanquery 的日期转换约定是：`OPEN ON begin` 的 begin 包含在期间内，`CLOSE ON end` 会截断 end 当日及其后的条目；官方明确说明 closing date 应为最后一个包含日的次日。[Beancount Query Language：日期转换](https://beancount.github.io/docs/beancount_query_language/)

这与现有 MoneyPal 的 `begin` 包含、`end` 排除约定一致，但查询写法仍需区分：

- 流水窗口：直接表达 `date >= begin AND date < end`。
- 期间损益：使用 `OPEN ON begin CLOSE ON end` 后聚合 Income/Expenses。
- 截止日余额：使用 `CLOSE ON dayAfter` 或等价的严格小于次日；不能把“只过滤期间 postings”误当成截止日存量。
- 资产负债表：还需 `CLEAR` 才会把期间损益结转到权益。

因此日期边界可以保持，但各工具必须有各自明确的会计转换，不能共用一个简单 WHERE 过滤器。

### 13. 商品、数字与多商品

官方入门文档要求商品标识使用大写字母形式，并明确 `$`、`€` 这样的符号不受支持。[Getting Started：Currencies](https://beancount.github.io/docs/getting_started_with_beancount/) 当前 lexer 的 currency token 也不是当前 MoneyPal 金额正则所接受的任意非空后缀；number token 要求小数点前至少有一位数字。[当前 lexer](https://github.com/beancount/beancount/blob/master/beancount/parser/lexer.l)

直接影响如下：

- 当前可接受的 `.5 CNY` 必须规范化为 `0.5 CNY`。
- 当前可能通过的 `10 $`、`10 €`、小写商品或任意 Unicode 商品不能原样渲染。
- 当前可能通过的无商品 `10` 不能作为普通 Beancount Amount 使用；posting 要么给出 `number currency`，要么整项 units 省略并交给插值器。
- Beancount Decimal 是精确值；MoneyPal 不应为了 JSON 输出将其隐式变成浮点数。
- 读取端必须面对一个 `Inventory` 含多商品/lot；写入端限制单商品不会使外部编辑过的账本自动满足这一假设。

### 14. 交易文本渲染

Beancount 交易至少包含日期、flag 和带引号 narration；一个字符串表示 narration，两个字符串表示 payee 与 narration。`txn` 可作为 `*` 的等价关键字。[Beancount Language Syntax：Transactions](https://beancount.github.io/docs/beancount_language_syntax/)

```beancount
2026-09-02 * "午餐"
  Expenses:F家庭:F食品  30 CNY
  Assets:A支付宝
```

这不同于当前无 flag、无引号标题的 hledger 渲染。官方 `EntryPrinter.Transaction` 已实现日期、flag、payee/narration 的引号与转义，以及 postings 的规范输出，可作为渲染语义的权威参考。[官方 printer 源码](https://github.com/beancount/beancount/blob/master/beancount/parser/printer.py)

MoneyPal 仍应拥有一个窄的交易渲染器：把已验证的领域输入映射为 Beancount directive，并用官方 parser/loader 反向验证。不能只替换标题行，因为账户映射、商品/数字合法性、省略金额、多商品和字符串转义都会改变。

## 没有直接等价物或必须自行定义的边界

下列事项不能被描述为“换一条 Beancount 命令即可”：

1. **hledger 原始 JSON**：beanquery CLI 当前没有 JSON renderer；MoneyPal 要定义稳定的结构化输出。
2. **完整损益表/资产负债表树**：查询可提供账户行和 inventory，但树、合计、显示符号与空分组属于产品层。
3. **候选交易叠加校验**：官方入口是一个顶层文件；组合方式要保留顶层 options、include 与错误位置。
4. **模糊重复检测**：默认 validation 与内容哈希都不等价于当前业务启发式。
5. **多商品读取契约**：Beancount 原生返回 inventory；MoneyPal 要决定保留、限制还是报错。
6. **账户显示名**：机械前缀可满足语法，但 Beancount 没有替 MoneyPal 自动隐藏前缀的显示别名机制。
7. **查询日期语义**：流水过滤、期间损益和截止日余额分别需要不同表达。

## 供后续票据验证的最小清单

本研究不选择实现，但后续原型至少应锁定以下事实：

- 用一个含中文机械前缀账户、`open`、可选 `commodity` 与两行 posting 的最小文件通过 `bean-check`。
- 从 Python API 输出 Decimal/Inventory 的自有 JSON，不依赖 CLI 文本或 CSV 反解析。
- 对同一 fixture 验证流水、截止日余额、期间损益与资产负债表四种日期口径。
- 构造 include 嵌套和 glob，确认快照文件集合包含顶层及全部实际文件。
- 构造候选交易违反 open 商品约束、账户未打开、金额不平衡和顶层 option 的案例，验证候选组合不会漏掉正式账本语义。
- 保留现有重复指纹测试，并把 beanquery 仅用作候选窗口数据源。
