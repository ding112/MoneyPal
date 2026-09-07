# hledger 在 Windows 上使用 UTF-8（不修改全局系统编码）

调研日期：2026-09-02  
适用范围：hledger 1.52.x、原生 Windows 版 hledger；PowerShell 5.1/7、CMD、Windows Terminal，以及 WSL/Git Bash 的相关边界。

## 结论

有办法，而且首选办法不需要启用 Windows 的“Beta: 使用 Unicode UTF-8 提供全球语言支持”。在 **启动 hledger 之前**，只把当前 PowerShell 或 CMD 控制台会话的输入、输出 code page 设为 UTF-8（65001），然后用 `hledger setup` 验证即可。关闭该终端窗口后设置失效，不会改变 Windows 的全局“非 Unicode 程序语言”。hledger 官方直接给出了 PowerShell 配置行；Microsoft 也说明，修改 code page 后启动的程序使用新 code page。[hledger：Text encoding](https://hledger.org/install.html#text-encoding)；[Microsoft：chcp](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/chcp)

更准确地说，问题不是“hledger 不支持 UTF-8”，而是：

- 普通 journal 文件没有通用的 `--encoding utf-8` 覆盖项。hledger 用进程的 system locale text encoding 解码 journal，并用同一编码输出；文件编码与它不一致时会报错或乱码。[hledger 1.52：Text encoding](https://hledger.org/1.52/hledger.html#text-encoding)
- CSV/SSV/TSV 是例外，可以在 rules 文件中显式写 `encoding utf-8`。[hledger 1.52：CSV encoding rule](https://hledger.org/1.52/hledger.html#encoding)
- Windows 上 GHC/base 的 locale encoding 优先取当前控制台输入 code page（`GetConsoleCP`），无控制台时回退到系统 ANSI code page（`GetACP`）。因此，要在 hledger 进程启动前修改当前控制台编码。[GHC/base Windows CodePage 源码](https://downloads.haskell.org/ghc/9.0.1-alpha1/docs/html/libraries/base-4.15.0.0/src/GHC-IO-Encoding-CodePage.html)；[GHC/base encoding API](https://downloads.haskell.org/ghc/9.6.2/docs/libraries/base-4.18.0.0/GHC-IO-Encoding.html)

## 首选方案：PowerShell 5.1 或 PowerShell 7

在 Windows Terminal 的 PowerShell 标签页，或普通 PowerShell 窗口中执行：

```powershell
$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding

([Console]::InputEncoding).CodePage
([Console]::OutputEncoding).CodePage
$OutputEncoding.CodePage

hledger setup
hledger -f 'C:\账本\main.journal' check
```

三个 code page 值都应为 `65001`；`hledger setup` 的 system text encoding 检查应显示 UTF-8。第一行是 hledger 官方给出的“不影响整个系统”的方法。[hledger：Text encoding](https://hledger.org/install.html#text-encoding)；[`hledger setup` 手册与示例](https://hledger.org/1.52/hledger.html#setup)

这行同时处理了三个不同通道：

- `[Console]::InputEncoding`：hledger 启动时，GHC/base 会据此选择 Windows locale encoding；这会影响 journal 文件和标准输入的解码。
- `[Console]::OutputEncoding`：让控制台按 UTF-8 接收原生程序输出。
- `$OutputEncoding`：PowerShell 向外部程序发送字符串时使用的编码；它不控制 PowerShell cmdlet 或重定向运算符写文件时的编码。[Microsoft：about_Character_Encoding](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding)

只在当前窗口执行即可；若希望每个 PowerShell 会话自动生效，可以把 hledger 官方的第一行放入对应 PowerShell 的 `$PROFILE`。这仍是 PowerShell 会话级配置，不是 Windows 全局系统 locale；但它会影响从该会话启动的其他控制台程序，最好为 hledger 使用单独的 Windows Terminal 标签页。

### PowerShell 5.1 的文件写入陷阱

Windows PowerShell 5.1 的 `>`/`>>` 会通过 `Out-File` 写出 UTF-16LE；`Set-Content` 新建文件时又默认使用系统 ANSI code page。不要用默认重定向创建或重写 UTF-8 journal，也不要假设 `$OutputEncoding` 会改变这些 cmdlet 的文件编码。[Microsoft：Windows PowerShell character encoding](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding#character-encoding-in-windows-powershell)

如果要把 hledger 报告保存为 UTF-8，优先让支持的 hledger 命令自己写文件；在上面的 UTF-8 会话设置之后，例如：

```powershell
hledger -f 'C:\账本\main.journal' balance -o 'C:\账本\balance.txt'
```

`print`、`register`、`stats` 和 balance 系列命令支持 `-o/--output-file`。[hledger：Output destination](https://hledger.org/1.52/hledger.html#output-destination)

### PowerShell 7 的差异

PowerShell 6+ 默认文本输出为 UTF-8 no BOM。PowerShell 7.4 起，原生程序 stdout 经 `>` 重定向时会保留原始字节流；这比 Windows PowerShell 5.1 更适合接收 hledger 的 UTF-8 输出。不过，仍应先执行官方的三项 encoding 设置，因为 PowerShell 的文件默认编码、控制台 code page 和 native-program pipeline encoding 是不同概念。[Microsoft：about_Character_Encoding](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding#character-encoding-in-powershell)；[Microsoft：about_Redirection](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_redirection#redirecting-output-from-native-commands)

## CMD：当前窗口执行 `chcp 65001`

```bat
chcp 65001
hledger setup
hledger -f "C:\账本\main.journal" check
```

`chcp 65001` 修改当前 console 的 active code page；Microsoft 说明，赋值后新启动的程序使用新的 code page。因此必须先执行 `chcp`，再启动 hledger。关闭 CMD/Windows Terminal 标签页即可恢复，不需要修改 Windows 全局设置。[Microsoft：chcp remarks](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/chcp#remarks)

hledger 的 Windows 问题 #961 也记录了在 CMD 中执行 `chcp 65001` 后，UTF-8 journal 的字符显示和列对齐正确。[hledger issue #961](https://github.com/simonmichael/hledger/issues/961)

局限：code page 是该 console 的共享状态；同一个窗口里随后启动的旧式程序也会看到 65001。Microsoft 还指出，UTF-8 控制台输入在某些旧的 cooked input 模式下并不完整；hledger 的交互式 `add` 或旧终端组合如果仍有输入问题，应改用新版 Windows Terminal + PowerShell，或用编辑器维护 journal。[Microsoft：Windows Console Unicode](https://learn.microsoft.com/en-us/windows/console/classic-vs-vt#unicode)

## 四类问题要分别排查

### 1. 终端显示、键盘输入与列对齐

控制台编码正确只是第一步。终端必须支持 Unicode，字体必须包含所需字形，宽字符应按双宽显示，否则中文可能显示为方框，或 hledger 表格列仍不齐。hledger 在 Windows 上建议必要时使用 Windows Terminal，并说明从 CMD/PowerShell 环境构建的二进制在 Cygwin/MSYS/mintty 中运行可能出现跨环境显示问题。[hledger：Unicode characters](https://hledger.org/1.52/hledger.html#unicode-characters)；[hledger：Windows 构建/运行环境](https://hledger.org/install.html#on-windows)

推荐组合是：**官方原生 Windows hledger + Windows Terminal + PowerShell 5.1/7 + 当前会话 UTF-8 设置**。

### 2. Journal 文件内容编码

控制台设为 UTF-8 不会自动转换已有 journal。编辑器必须把主账本和所有 `include` 的交易文件实际保存为 UTF-8；否则 hledger 以 UTF-8 解码旧的 CP936/GBK 文件时仍会失败。反过来，如果不打算使用 UTF-8，也可以把所有 journal 统一转换成 `hledger setup` 推荐的系统编码；这是 hledger 官方列出的另一条解决路线。[hledger：Text encoding](https://hledger.org/install.html#text-encoding)；[hledger：Start a journal](https://hledger.org/start-a-journal.html)

在 VS Code 中可通过状态栏查看编码，点击编码项后选择 **Save with Encoding → UTF-8**；也可以用 `files.encoding` 做工作区级设置。保存编码和“以某编码重新打开”是两个不同操作，转换时应使用前者。[VS Code：File encoding support](https://code.visualstudio.com/docs/editing/codebasics#_file-encoding-support)

不应依赖 BOM 来让 hledger 自动判断 journal 编码。普通 journal 的规则仍是“文件内容编码必须与 hledger 检测到的 system text encoding 一致”；只有 CSV/SSV/TSV 有按文件指定编码的规则。[hledger：Text encoding](https://hledger.org/1.52/hledger.html#text-encoding)

### 3. 文件名和路径

文件内容解码与文件名/路径是两层问题。现代 Haskell/Windows 文件路径在 Windows 侧使用宽字符/UTF-16 语义；中文路径本身不意味着 journal 内容也采用 UTF-8。[GHC `System.OsString.Windows`](https://ghc.gitlab.haskell.org/ghc/doc/libraries/os-string-2.0.8-inplace/System-OsString-Windows.html)

但原生 Windows hledger 不认识 Cygwin/MSYS 的 `/home/...` 虚拟文件系统路径。若从这类 shell 传路径，应使用相对路径、实际 Windows 路径，或用 `cygpath` 转换。GHC 官方对原生 GHC/GHC 编译程序给出了同样说明。[GHC：Using GHC-compiled executables with Cygwin](https://downloads.haskell.org/ghc/9.10.1-alpha2/docs/users_guide/win32-dlls.html#using-ghc-and-other-ghc-compiled-executables-with-cygwin)

### 4. 编辑器保存编码

编辑器里“看起来正常”不代表磁盘字节就是 hledger 当前期望的编码。应同时确认：

1. 编辑器状态栏显示 UTF-8，并以 UTF-8 保存所有 journal/include 文件；
2. 启动 hledger 的同一窗口已设为 65001；
3. `hledger setup` 报告 UTF-8；
4. `hledger -f '文件' check` 成功。

## Git Bash / MSYS / mintty

不建议把 `export LANG=C.UTF-8` 当成原生 Windows hledger 的可靠修复。hledger 文档中的 `LANG` 方法是 Unix/Linux locale 方案；Windows 版 GHC/base 则读取 `GetConsoleCP`，无 console 时回退 `GetACP`。[hledger：Text encoding](https://hledger.org/install.html#text-encoding)；[GHC/base CodePage 源码](https://downloads.haskell.org/ghc/9.0.1-alpha1/docs/html/libraries/base-4.15.0.0/src/GHC-IO-Encoding-CodePage.html)

Git Bash 常由 mintty 承载，与官方原生 Windows hledger 的构建环境不同。hledger 官方明确提醒：最好在与构建时相同类型的环境中运行；issue #961 记录了 UTF-8 文件在 mintty 中可读但报告仍错位，而 CMD + `chcp 65001` 正常。[hledger：On Windows](https://hledger.org/install.html#on-windows)；[hledger issue #961](https://github.com/simonmichael/hledger/issues/961)

所以可执行建议是：

- 官方 Windows 二进制放在 Windows Terminal 的 PowerShell/CMD profile 中运行；
- 如果必须在 MSYS/Cygwin 内长期运行，应在同一环境构建并使用 hledger，但这比会话级 PowerShell 方案复杂；
- 不要把 Windows 原生 hledger 与 WSL/Linux 构建的 hledger 混用。

## 无控制台进程：计划任务、服务、GUI/MCP 宿主

这是会话级方案的硬边界。若 hledger 由没有附着 console 的计划任务、服务、GUI 或某些 MCP 宿主直接启动，GHC/base 的 `GetConsoleCP` 得不到有效 code page，会回退到系统 ANSI code page；此时 PowerShell 的 `[Console]` 设置和 `chcp` 都不能可靠控制该 hledger 进程。[GHC/base CodePage 源码](https://downloads.haskell.org/ghc/9.0.1-alpha1/docs/html/libraries/base-4.15.0.0/src/GHC-IO-Encoding-CodePage.html)

不修改 Windows 全局 locale 时，有三种选择：

1. 让宿主通过一个附着到 UTF-8 console 的 PowerShell/CMD wrapper 启动 hledger，并用 `hledger setup` 在真实启动链路中验证；是否有效取决于宿主是否真的保留 console。
2. 把 journal 统一转换成该机器的系统 ANSI 编码。这是 hledger 官方支持、但跨平台性较差的方案。
3. 在 WSL 中安装并运行 Linux 版 hledger，使用已配置的 UTF-8 locale；Windows 的 `C:\...` 在 WSL 中映射为 `/mnt/c/...`，也可以从 PowerShell/CMD 用 `wsl <command>` 调用 Linux 命令。[Microsoft：WSL](https://learn.microsoft.com/en-us/windows/wsl/install)；[Microsoft：Working across file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)；[hledger：Unix locale](https://hledger.org/install.html#text-encoding)

WSL 的代价是多一套运行环境，并且必须使用 **Linux 版** hledger、Linux 路径和 UTF-8 locale；不要在 WSL 里启动 Windows `hledger.exe` 后假设它会获得 Linux locale。

Windows 10 1903+ 还支持通过 unpackaged Win32 app 的 fusion manifest 把 **单个进程** 的 active code page 设为 UTF-8，而不改变全局系统 locale。Microsoft 给出了 `<activeCodePage>UTF-8</activeCodePage>` 及用 `mt.exe` 写入现有 EXE 的方法。[Microsoft：Use UTF-8 code pages in Windows apps](https://learn.microsoft.com/en-us/windows/apps/design/globalizing/use-utf8-code-page#set-a-process-code-page-to-utf-8) 但 hledger 官方没有把它作为发行二进制的用户操作指南；它会修改 EXE 资源、可能被升级覆盖，也需要 Windows SDK 工具。因此只把它视为受控部署环境中的高级备选，应先复制 EXE，并用 `hledger setup` 和含中文的测试 journal 验证，而不是普通用户的首选方案。

## 不可靠或无效的“修复”

- 只换 Windows Terminal：它改善终端承载和字体/Unicode 能力，但不会自动保证 hledger 启动时的 console code page 是 65001；仍应执行 encoding 设置并检查 `hledger setup`。
- 只设置 `LANG`/`LC_ALL`：这是 Unix locale 方法，不是原生 Windows GHC/base 选择 locale encoding 的可靠入口。
- 设置 `GHC_CHARENC=UTF-8`：GHC 官方把它定义为控制 **编译器** 诊断输出的环境变量，不是任意 GHC 编译程序的文件解码设置，不能据此让 hledger 以 UTF-8 读取 journal。[GHC User's Guide：`GHC_CHARENC`](https://downloads.haskell.org/~ghc/latest/docs/users_guide.pdf)
- 只把 journal 另存为 UTF-8：如果 hledger 启动时仍检测到 CP936/其他系统编码，编码仍不匹配。
- 只执行 `$OutputEncoding = ...`：它只影响 PowerShell 向原生程序传递字符串；应按 hledger 官方命令同时设置 Console InputEncoding 和 OutputEncoding。[Microsoft：`$OutputEncoding`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding#changing-the-default-encoding)

## 最短排错清单

在 PowerShell 中逐项运行，并保留输出：

```powershell
hledger --version
[System.Text.Encoding]::Default.EncodingName
([Console]::InputEncoding).EncodingName
([Console]::OutputEncoding).EncodingName
$OutputEncoding.EncodingName

$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding

hledger setup
hledger -f 'C:\账本\main.journal' check
```

若 `setup` 仍不显示 UTF-8，优先检查是否实际运行了另一个 `hledger.exe`、是否在 Git Bash/mintty/无控制台宿主中启动，以及所有 include 文件是否也是 UTF-8。若 `check` 成功但显示乱码，则转查 Windows Terminal profile、字体和宽字符对齐，而不是继续转换 journal。
