# Beancount v3 运行时集成与分发能力

调研日期：2026-09-02  
适用仓库：MoneyPal / hledger-agent  
调研基线：Beancount 3.2.3、beanquery 0.2.0、Node.js 22

## 结论摘要

Beancount v3 适合通过一个独立 Python 进程接入 Node.js 22，但官方组件没有提供一个同时覆盖“校验、查询、稳定 JSON、取消和超时”的现成命令。

- Beancount 3 是自 2024 年 6 月起的官方稳定版本；v3 核心包已裁掉多数 v2 工具，查询由独立的 beanquery 包提供。[Beancount 官方仓库的版本说明](https://github.com/beancount/beancount#versions)
- Beancount 3.2.3 的 `bean-check --json` 可以输出结构化校验错误，并用退出码区分成功和失败；它是可直接用于机器校验的官方 CLI。[3.2.3 的 `check.py`](https://github.com/beancount/beancount/blob/3.2.3/beancount/scripts/check.py#L15-L92)
- beanquery 0.2.0 的 `bean-query` CLI 支持 text、CSV 和 Beancount 三种 renderer，没有 JSON renderer。CSV 是可解析的表格文本，但已经丢失 Python 类型信息，并把 Amount、Position、Inventory 等值渲染为字符串。[0.2.0 的 renderer 目录](https://github.com/beancount/beanquery/tree/v0.2.0/beanquery/render)；[CSV renderer](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/query_render.py#L555-L582)
- beanquery 的 Python API 能返回列描述和 Python 类型值，适合由 MoneyPal 自己的 bridge 转换成稳定领域 JSON；但 Beancount/beanquery 没有公开的查询取消或超时参数，调用是同步、急切求值的。[`run_query()`](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/query.py#L10-L39)；[`Cursor.execute()`](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/cursor.py#L79-L125)
- 因此取消和超时最清晰的隔离边界是短生命周期 Python 子进程。Node.js 22 的异步 `spawn()`/`execFile()` 支持 `AbortSignal` 和超时；直接启动 Python、不开 shell，可以让终止信号作用于实际执行 Beancount 的进程。[Node.js 22 child process 文档](https://nodejs.org/download/release/v22.22.0/docs/api/child_process.html#child_processexecfilefile-args-options-callback)
- Beancount 3.2.3 有 CPython 3.9–3.14 的 macOS、manylinux 和 Windows wheel；beanquery 0.2.0 是纯 Python 通用 wheel。官方发行矩阵没有 musllinux、Linux armv7、Windows ARM64 等 wheel，这些目标不能假定免编译安装。[Beancount 3.2.3 PyPI 文件列表](https://pypi.org/project/beancount/3.2.3/#files)；[beanquery 0.2.0 PyPI 文件列表](https://pypi.org/project/beanquery/0.2.0/#files)

研究支持后续比较三类集成方式：直接组合官方 CLI、每次调用一个 MoneyPal Python JSON bridge、常驻 Python worker。本票据不在三者中作最终选择。

## 官方组件边界

### Beancount v3 核心

Beancount 3.2.3 要求 Python 3.9 以上，运行依赖为 Click、python-dateutil 和 regex。它使用 `mesonpy` 构建，发布的命令只有 `bean-check`、`bean-doctor`、`bean-example`、`bean-format` 和 `treeify`；核心包不发布 `bean-query` 或 `bean-report`。[3.2.3 `pyproject.toml`](https://github.com/beancount/beancount/blob/3.2.3/pyproject.toml#L1-L61)

官方 `beancount.loader.load_file()` 是适合程序化加载的 Python interface。它返回 `(entries, errors, options_map)`，并在一次加载中完成递归解析、booking、插件转换和基础验证。[3.2.3 loader interface](https://github.com/beancount/beancount/blob/3.2.3/beancount/loader.py#L85-L128)；[加载流水线](https://github.com/beancount/beancount/blob/3.2.3/beancount/loader.py#L585-L636)

基础验证包括账户 open/close、账户活跃性、币种约束、重复 balance/commodity、文档路径以及交易平衡检查。`bean-check` 还显式加入较慢的 data type 验证，因此只调用默认 `load_file()` 与运行 `bean-check` 的验证强度并不完全相同。[验证集合](https://github.com/beancount/beancount/blob/3.2.3/beancount/ops/validation.py#L390-L427)；[`bean-check` 加入 hardcore validation](https://github.com/beancount/beancount/blob/3.2.3/beancount/scripts/check.py#L62-L84)

### beanquery

beanquery 0.2.0 要求 Python 3.8 以上，并声明依赖 `beancount >= 2.3.4`。与 Beancount 3 一起部署时，有效的最低 Python 版本仍由 Beancount 提升到 3.9。[beanquery 0.2.0 包元数据](https://github.com/beancount/beanquery/blob/v0.2.0/pyproject.toml#L1-L62)

它提供两个程序化入口：

1. `beanquery.query.run_query(entries, options, query, ..., numberify=False)`：接收 Beancount loader 的结果，返回列描述和全部结果行。
2. 类 DB-API 2.0 interface：`beanquery.connect()`、`Connection.execute()`、`Cursor.description`、`fetchone/fetchmany/fetchall`。其连接对象还保留 `errors` 与 `options`。[beanquery package interface](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/__init__.py#L1-L75)；[Cursor interface](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/cursor.py#L1-L125)

查询语言支持一般 `SELECT`，也提供 `PRINT`、`JOURNAL`、`BALANCES` 等便利语句；`OPEN`、`CLOSE`、`CLEAR` 用于按会计期间重写查询输入。[beanquery shell 中的查询语义](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/shell.py#L516-L620)

这足以构造 MoneyPal 当前的流水、余额及报表数据，但官方没有继续提供 v2 `bean-report` 的固定损益表/资产负债表命令。后续规格必须明确这些报表的 BQL 或 Python 聚合语义，不能把“安装 beanquery”当成报表语义已经自动等价。

## 结构化输出能力

### 校验：官方 JSON 可直接使用

`bean-check --json <file>` 输出单个 JSON object：

```json
{
  "errors": [
    {
      "message": "...",
      "filename": "...",
      "lineno": 12
    }
  ]
}
```

无错误时 `errors` 为空且退出码为 0；有错误时退出码为 1。JSON 只承诺源码中这三个错误字段，不包含错误类别、原始 entry 或 include 栈。[`_error_to_json()` 与退出码](https://github.com/beancount/beancount/blob/3.2.3/beancount/scripts/check.py#L15-L23)；[`--json` 输出](https://github.com/beancount/beancount/blob/3.2.3/beancount/scripts/check.py#L79-L92)

若用 Python bridge 校验，可以直接读取完整 error 对象，但要想与 `bean-check` 等强度，bridge 必须向 `load_file()` 传入 `validation.HARDCORE_VALIDATIONS`。否则两条校验路径可能对 data type 问题给出不同结果。

### 查询 CLI：CSV 可解析，但不是稳定领域 JSON

`bean-query` 接受 `--format`、`--numberify`、`--no-errors`，查询可作为参数传入或从 stdin 读取。[beanquery 0.2.0 CLI](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/shell.py#L768-L812)

其机器可读程度有四个限制：

- 无 JSON renderer；可选格式由 `render/` 下的 `beancount.py`、`csv.py`、`text.py` 动态组成。[format 注册](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/shell.py#L81-L89)
- CSV 首行是列名，其余值经过 renderer 变成文本；列的数据类型不会随 CSV 输出传递。[CSV 实现](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/query_render.py#L555-L582)
- `--numberify` 会依据本次结果中实际出现的币种，把 Amount、Position、Inventory 动态拆成每币种 Decimal 列，因此列集合和顺序依赖数据；它适合导入表格，不适合作为未经适配的长期 API schema。[numberify 设计与实现](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/numberify.py#L1-L103)
- `--no-errors` 只是禁止打印加载错误。CLI 即使加载到 validation errors，仍会继续执行查询；源码没有将这些加载错误转换成非零退出码。因此查询成功不等于账本通过校验。[加载错误处理](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/shell.py#L377-L429)；[batch main](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/shell.py#L782-L812)

所以，如果选择直接 CLI，可靠流程至少需要独立运行 `bean-check --json`，再运行 `bean-query --format csv` 并解析 CSV。两次进程会各自加载账本，且两次读取之间账本可能变化；这种竞态是后续安全写入决策必须处理的约束。

### Python bridge：保留类型，但序列化契约由 MoneyPal 负责

Python API 返回列名、列 datatype 和 Python row 值，避免先经过 CSV 文本化。其值可能包含 `Decimal`、`date`、Amount、Position、Inventory、Set、Beancount directive 等，不能直接交给标准 `json.dumps()`。bridge 必须把它们规范化为 MoneyPal 选择的 JSON schema，例如把 Decimal 保留为十进制字符串、把币种作为独立字段；具体 schema 应由后续工具契约票据决定，而不是照搬 Python 对象表示。

该方式还可以在同一次 `load_file()` 的结果上先检查 errors、再查询，避免“校验进程”和“查询进程”观察到不同文件版本。

## 取消、超时和资源上限

在 Beancount 3.2.3 与 beanquery 0.2.0 的公开 Python interface 中没有 timeout、cancel token 或 cursor cancellation 方法。`Cursor.execute()` 同步编译并执行查询，把结果行保存在 cursor 中；`run_query()` 随后调用 `fetchall()`。[`Cursor.execute()`](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/cursor.py#L79-L125)；[`run_query()`](https://github.com/beancount/beanquery/blob/v0.2.0/beanquery/query.py#L10-L39)

Node.js 22 可以在进程边界补足这些控制：

- `execFile()` 直接启动 executable，不默认经过 shell；支持 `signal`、`timeout`、`killSignal`、`maxBuffer` 和 `windowsHide`。[Node.js 22 `execFile()`](https://nodejs.org/download/release/v22.22.0/docs/api/child_process.html#child_processexecfilefile-args-options-callback)
- `spawn()` 同样支持 AbortSignal 与 timeout，并以 stream 提供 stdout/stderr，调用方可自行实施输出字节上限；这避免 `execFile()` 默认 1 MiB `maxBuffer` 对大查询的隐式截断。[Node.js 22 `spawn()` 与管道](https://nodejs.org/download/release/v22.22.0/docs/api/child_process.html#child_processspawncommand-args-options)
- abort 与 timeout 都是向子进程发送 kill signal，不是 Beancount 的协作式取消。在 Windows 上，Node 对支持的 signal 最终都是强制、突然终止；在 Linux 上，杀父进程不会自动杀掉其子孙进程。[Node.js 22 kill 语义](https://nodejs.org/download/release/v22.22.0/docs/api/child_process.html#subprocesskillsignal)

由此可以得出两个边界事实：

1. 若 Node 直接启动一个不再派生子进程的 Python bridge，一次请求一个进程，则取消和超时可以可靠结束该次 Beancount 工作，并顺带释放其内存。
2. 若选择常驻 Python worker，终止整个 worker 能取消当前查询，但会同时丢失该 worker 中其他请求/缓存；官方 API 不支持在同一进程里只取消某一个同步查询。要做请求级强取消，需要 worker 再隔离进程，或接受自定义非官方机制。

不论选择哪种方式，规格仍需明确 stdout/stderr 字节上限和超限错误映射；官方 beanquery 会在内存中形成完整结果，不能靠 cursor 名称假定它是流式数据库。

## 安装、平台与运行时发现

### 官方发行矩阵

截至调研日，PyPI 最新稳定版分别是 Beancount 3.2.3 和 beanquery 0.2.0。[Beancount PyPI](https://pypi.org/project/beancount/)；[beanquery PyPI](https://pypi.org/project/beanquery/)

Beancount 3.2.3 的完整 wheel 集覆盖：

| Python ABI | macOS | Linux | Windows |
|---|---|---|---|
| CPython 3.9–3.11 | x86-64、Apple Silicon | manylinux x86-64、aarch64 | x86、x86-64 |
| CPython 3.12–3.13 | x86-64、Apple Silicon | manylinux x86-64、aarch64 | x86、x86-64 |
| CPython 3.14、3.14 free-threaded | x86-64、Apple Silicon | manylinux x86-64、aarch64 | x86、x86-64 |

这些是 CPython 和平台专用 wheel，不是可随意搬运的纯 Python 环境。beanquery 0.2.0 则发布 `py3-none-any` wheel，但它依赖 Beancount，所以最终部署能力仍由 Beancount wheel 决定。[Beancount 文件元数据](https://pypi.org/project/beancount/3.2.3/#files)；[beanquery 文件元数据](https://pypi.org/project/beanquery/0.2.0/#files)

对于没有匹配 wheel 的平台，pip 会退回 source distribution。Beancount 的构建后端是 meson-python，构建配置按 Linux/macOS 引入 flex、bison，按 Windows 引入 winflexbison；官方开发安装文档还要求 Meson/Ninja，并依赖本地构建环境。[3.2.3 build metadata](https://github.com/beancount/beancount/blob/3.2.3/pyproject.toml#L1-L12)；[官方 v3 Meson 安装说明](https://beancount.github.io/docs/installing_beancount_v3/#installation-for-development-with-meson)

### 可执行文件发现

pip 安装后会依据 package entry point 生成 `bean-check` 和 `bean-query` 命令。虚拟环境中的命令位于 POSIX 的 `<venv>/bin` 或 Windows 的 `<venv>\Scripts`。Python 官方说明不要求激活环境；调用方可以直接使用虚拟环境 Python 的绝对路径。虚拟环境含绝对路径，因此通常不可搬运，移动后应重建。[Python `venv` 文档](https://docs.python.org/3/library/venv.html#how-venvs-work)

后续架构应在以下发现策略中取舍：

- **显式配置 executable/interpreter 路径**：最可预测，适合用户自管 Python 或系统包；配置错误需要清晰的启动诊断。
- **MoneyPal 管理固定位置的 venv**：两个 npm adapter 可共享一个明确运行时位置，但安装、升级、离线部署、代理、权限和 venv 重建成为产品责任。
- **只从 `PATH` 查找 `bean-check`/`bean-query`/`python`**：实现最少，但容易选中不同 Python 环境中的不兼容包；Windows 的 Python Scripts 目录也不保证默认在 PATH。[Python Windows 的命令与 Scripts 目录说明](https://docs.python.org/3/using/windows.html#the-python-install-manager)
- **调用明确 Python 后再进入模块或 MoneyPal bridge**：避免分别发现两个 console script，并能先做版本握手；但仍要先确定那一个 Python interpreter。

无论采用哪种策略，启动握手至少应核实 Python 版本、`beancount`/`beanquery` 是否可 import 以及精确包版本，并把“未找到 Python”“缺少包”“版本不支持”“平台无 wheel/安装失败”区分开。是否由 npm 安装流程自动创建 Python 环境，是发布策略决策，不是 Beancount 自身能解决的能力。

### 分发与许可证约束

Beancount 3.2.3 与 beanquery 0.2.0 的官方包元数据都标注 GPL-2.0-only。[Beancount metadata](https://github.com/beancount/beancount/blob/3.2.3/pyproject.toml#L14-L35)；[beanquery metadata](https://github.com/beancount/beanquery/blob/v0.2.0/pyproject.toml#L5-L32)

“要求用户自行安装”与“把 Python、Beancount 和 beanquery 一并放进 npm/平台安装包”是不同的分发形态。若选择后者，规格应增加许可证与源代码提供义务的正式审查；本研究仅记录元数据，不给出法律结论。

## 运行时副作用与信任边界

Beancount loader 默认启用 pickle load cache：加载超过阈值时可能在入口账本旁创建 `.<filename>.picklecache`。`bean-check --no-cache` 可以禁用；Python bridge 可调用 `loader.initialize(False)`，或通过 `BEANCOUNT_DISABLE_LOAD_CACHE` 控制。[loader cache 实现与默认值](https://github.com/beancount/beancount/blob/3.2.3/beancount/loader.py#L180-L285)；[loader 初始化](https://github.com/beancount/beancount/blob/3.2.3/beancount/loader.py#L811-L847)

这意味着“只读查询/校验不修改账本工作区”并非默认成立。后续写入安全规格必须明确是否禁用 cache，或把 cache 定向到工作区外的受控位置。

loader 还会 import 账本 `plugin` 指令指定的 Python 模块并执行其 callback；账本 `pythonpath` 也会临时加入 `sys.path`。[plugin 加载与执行](https://github.com/beancount/beancount/blob/3.2.3/beancount/loader.py#L641-L742)

因此 Beancount 文件不是对不可信输入的纯数据解析格式。即使首版把插件能力列为产品范围外，规格也必须决定是拒绝 plugin/pythonpath 指令、信任整个正式账本工作区，还是把运行时放进更强隔离环境。普通子进程只提供故障/取消隔离，不自动构成安全沙箱。

## 后续架构决策要权衡的方案

| 方案 | 结构化结果 | 校验一致性 | 取消/超时 | 分发与复杂度 | 已知限制 |
|---|---|---|---|---|---|
| 官方 CLI 组合：`bean-check --json` + `bean-query --format csv` | 校验为 JSON；查询为 CSV | 两次独立加载 | 可杀各自子进程 | bridge 代码最少；仍需 Python 两包 | 查询无类型；加载竞态；报表 schema 依赖 CSV/numberify；bean-query load errors 不等于退出失败 |
| 每请求启动 MoneyPal Python JSON bridge | 可输出稳定领域 JSON | 一次 load 后校验与查询 | 直接杀 bridge | 需维护一小层 Python 协议 | 每次有 Python 启动与账本加载成本；要自己序列化类型、限制输出 |
| 常驻 MoneyPal Python worker | 可输出稳定领域 JSON | 可复用一次 load/缓存 | 官方 API 无请求级强取消 | 启动与重复加载成本较低 | 生命周期、文件刷新、并发、崩溃恢复、取消隔离和内存上限更复杂 |
| Node 内嵌 CPython/本地 binding | 理论上可直接取对象 | 可自行控制 | 取决于自建 binding | 最高 | Beancount 官方未发布 Node API、Node-API addon 或 WASM 构建；会把 CPython ABI/平台构建带入两个 npm 包 |

后续票据至少需要明确：

1. 选择 CLI 组合、短生命周期 bridge 或常驻 worker，并定义 DSH/MCP 共用的运行时 seam。
2. 明确查询结果的领域 JSON schema，尤其 Decimal、金额/币种、日期、空值和多币种结果。
3. 决定 Python 环境由用户提供还是 MoneyPal 管理，以及支持的平台/Python 版本下限。
4. 定义启动握手、版本约束、错误分类、stdout/stderr 上限、超时和用户取消语义。
5. 明确 loader cache 策略以及 plugin/pythonpath 信任策略。
6. 原型验证所选方式在目标平台上的取消、超时、大输出、无效账本和并发行为。

## 本票据未决定的事项

本研究不选择最终集成方式，不定义 MoneyPal 工具输出 schema，不决定安装器行为，也不验证具体 BQL 是否与 hledger 当前报表日期语义完全等价。这些都应由后续决策或原型票据解决。
