# SightRead 设计文档

> 日期：2026-07-07
> 前置：定位与功能取舍见 [discussion.md](./discussion.md)、[features.md](./features.md)
> 本文记录经三轮讨论收敛后的**当前版本**设计，是实现的直接依据。

## 一、总原则

1. **主要功能本地静态**：视觉辅助层无网络依赖、毫秒级响应；LLM 只提供必要的信息增益（解读与路线，§3.8）——永远显式发起、可选、不自动运行。
2. **标注是短命的**：服务于当前这轮阅读，过期即弃。宁可误删，不留脏。不做导出、分享、过期检测。
3. **语义正交**：五个功能各占一条轴——结构（段落化）、注意力（聚光灯）、数据流（变量染色）、判断（荧光笔）、细节层级（骨架折叠）。
4. **渲染冲突集中治理**：所有装饰经由唯一的渲染协调器（compositor）下发，任何功能不得直接调 `setDecorations`。

## 二、视觉通道独占表

| 通道 | 归属 |
|------|------|
| 背景填充（isWholeLine） | 标记（手动色 + AI 角色色，同一渲染通路） |
| 描边 / 边框 | 变量染色（读一色、写一色） |
| 文字 opacity | 聚光灯置灰（两档灰度） |
| 行尾 `after` 标签 | 标记说明文字（✎ 手动 note / ✦ 摘要 / ① 步骤） |
| gutter 图标 + overview ruler | 标记 |
| CodeLens | 入口点（entry 声明行上方，2026-08-11 替代 gutter 雪佛龙） |
| 折叠 | 骨架折叠（纯命令，不注册 provider） |
| Outline / Sticky Scroll | 段落（实验性，默认关闭） |

图层（持久，可共存）：标记。
模式（瞬时）：聚光灯（唯一模式，三档）。模式激活时压制图层：置灰区内的标记由 compositor 降为低透明度变体，退出恢复。
变量染色是常开的瞬时效果（描边系），不与填充冲突，同时兼任聚光灯三档的焦点输入。

## 三、功能规格

### 3.1 骨架折叠

- `sightread.foldSkeleton`：折叠行优先取**语言折叠 provider 的真实区间**（`vscode.executeFoldingRangeProvider`，运行时探测，不可用则退回段落树的启发式 `headerLines`），过滤为"完全落在函数体内"的区（以 `extractBody` 的函数体起始行为界，排除签名、装饰器、函数自身的区），一次 `editor.fold { levels: 1, selectionLines }` 折叠。
- `sightread.unfoldSkeleton`：先对函数体内一行做 `editor.unfold { direction: 'up', levels: 32 }` 展开被折叠的祖先链（method/class 被误折时，只展开内部区在屏幕上毫无变化），再对同组行展开内部区。
- **两个教训**（2026-07-07 两轮修复）：① `editor.fold` 不带 `levels`/`direction` 时走"已折叠则折其父区"的交互路径（`setCollapseStateUp`），候选行与语言折叠模型稍有不一致就会波及 method 乃至整个 class——程序化折叠必须显式传 `levels: 1`；② 启发式头行和语言折叠区不保证一致，能拿到 provider 真实区间就用真实区间。
- 不注册 FoldingRangeProvider，复用语言自带折叠区间。零冲突表面。
- **与 Segments 树联动**（2026-07-07）：树节点折叠/展开 → 对应代码区折叠/展开（`editor.fold/unfold` + `selectionLines`）；Segments 标题栏的 fold/unfold 按钮双向同步（fold 折代码并收起整棵树，unfold 反之）。反方向（编辑器里手动点折叠箭头 → 树收起）做不了：平台没有代码折叠变化的公开事件。
- **Segments item 右键深折叠**（2026-07-14）：`Fold/Unfold All Inside Segment` 折/展该段**内部**的全部折叠区（自身区排除——折掉自己就看不到正在检视的结构了）。区间来源与骨架折叠同构：优先语言折叠 provider（过滤为严格落在段内），退化为段落树 headerLines；unfold 先向上展开该段自身（骨架折叠的教训）。只作用于编辑器，树的展开态不动（单向同步的既有限制）。

### 3.2 标记（mark；2026-08-11 与 AI 解读合并为统一模型）

- 数据（`core/marks.ts`）：`Mark { id, accent, note?, preview?, guideId?, order?, startLine, endLine }`，**行粒度**，持久化于 `workspaceState`（不进 repo、不建文件；旧的 markers/guides 两个 key 首次激活时迁移进统一 key `sightread.marks`）。
- **accent 二元**：`{kind:'color', color}`（手动五色）或 `{kind:'role', role?}`（AI 步骤）。手动标记与 AI 步骤除归属（`guideId` + `order`）外无任何区别：同一渲染通路、同一过滤域、同一编辑同步算法。guide 只是元数据壳 `{id, subject, unit, summary?}`，行范围由存活步骤推导（envelope），最后一个步骤死亡时壳随删。
- 调色板：yellow（重点）/ red（存疑）/ green（已验证）/ blue / purple；每色一条独立命令（`Mark Selection: Yellow` …）供用户自绑快捷键，favorite 概念随之退役。
- 说明文字：默认渲染在标记区**首行行尾**（`after` 装饰）；`sightread.marker.notePosition = lineStart` 可切到行首。✎ = 手动 note，✦ = guide 摘要（挂 envelope 首行），① = 步骤徽章。
- **吞并规则**：新手动标记吞掉与之相交的 loose 手动标记（背景叠加成泥）；**guide 步骤不吞**——步骤归 guide 所有，手动标记盖上去是"人的判断叠在 AI 之上"，重叠处颜色优先显示。
- 删除双保险：
  - **自动（逐条语义，2026-08-11 起）**：任何编辑与某条标记的行范围相交 → 删那一条；其余各自平移。AI 步骤同规则——解读不再整份存亡。
  - **手动批量**：删除选区内 / 当前函数内 / 当前文件内（含 AI 步骤）/ 全 workspace（Clear All，带确认）。
- **过滤**（Filter Marks…）：多选 QuickPick 列当前文件实际出现的 accent key（`color:yellow` / `role:main` / `role:` 未标注）∪ 已隐藏项，颜色排前、角色按语义组排序。隐藏集全局生效：编辑器装饰、Markers 视图、Segments/Trail 的 label 染色一律消失；状态栏 `N hidden` 项兜底提示。
- 侧边栏 **Markers 视图**：按文件分组、行序混排 guide 节点与 loose 标记；步骤与手动标记同 contextValue（`mark`）——inline 垃圾桶与 Edit Note 对两者一视同仁（步骤的 note 可改可存）。标题栏：Interpret (AI) / Mark with Note / Filter（动态互换）/ Collapse-Expand All（动态互换，仅树），溢出菜单 Clear All。message 行显示过滤态（`⊘ N hidden`，N = 真实被隐藏的标记数而非隐藏键数；0 时必须清空 message——message 会压制 viewsWelcome，残留会让清空后的视图回不到空态。整文件被滤空时该文件行一并消失）。
- **视图跟随光标**（2026-07-14）：光标落在某标记行内 → Markers 视图选中该条目（loose 优先于步骤；树处于收起态时跳过）。

### 3.3 变量染色（variable tint）

- 自动、瞬时：光标落在 identifier 上（防抖后）→ 该 symbol 在**当前函数内**的所有 occurrence 描边显示；读 = 蓝色实线框，写 = 橙色框加粗。光标移开即消退。
- occurrence 来源：`vscode.executeDocumentHighlights`（自带读写区分）；无 provider 的语言退化为函数范围内的词边界文本匹配。
- 与荧光笔的对偶：自动 vs 手动、瞬时 vs 持久、推断范围 vs 选定范围、描边 vs 填充。

### 3.4 自动切段（segmentation）

- 唯一来源是自动（手动划段因"划完即读完"悖论被废弃）。信号三个：
  1. **空行**分隔；
  2. **顶层块**（if/else、循环、try/catch、内部闭包——由缩进回落 + 续行关键字识别）自成一段，块长 < 3 行的并入邻段；
  3. **注释/装饰器行绑定下一段**。
- **递归树结构**（2026-07-07 第二版）：块段落的内部（更深缩进的每一段连续区）递归切段成子节点，根即函数，深度上限 5。call/assignment/flow 类段落不向下递归（多行调用的参数不是结构）。
- **结构化命名**，注释内容永不作为段落名：
  - 分支：`if ...` / `if ... else ...` / `if ... elif{3} ... else ...`（关键字取语言实际所用，如 JS 的 `else if`）
  - 循环 `for ...`/`while ...`，上下文 `with ...`，异常 `try ... except ... finally ...`，分派 `switch ...`/`match ...`
  - 定义：`def foo` / `class Bar` / `function baz`（语言关键字 + 名字）
  - 函数值赋值（2026-08-11）：`const f = () => {}` / `f = function (…)` 归 definition 而非 assignment——命名与其他定义同族"关键字 + 名字"：`function f`（左值路径经 shortenPath 去 this/self），箭头语法本身是代码的事不是树的事；并随 definition 参与递归切段（此前按赋值段处理导致体内不再切分）。仅当绑定独占单元（单独一段，或首行后只剩闭合行）才成立——单行箭头混进语句组不抢组名；函数类型标注的左值（标注自带 `=>`）识别不了，退回赋值段，接受。
  - 赋值段（2026-08-09 第二版，数据流边）：右值含调用时 `related=_expand(...)`——产物与产生它的操作同显，流水线函数因此可读；右值无调用（字面量、多行右值、三元条件）退回 `a=..`。每行一个 token，最多 4 个，超出加 `…`。调用路径去 `self`/`this` 并只留最后两段（`vscode.workspace.textDocuments.find` → `textDocuments.find`）；运算符后面的调用视为操作数不取（`total / len(xs)` → `avg=..`）。段内含赋值即为 assignment kind（图标不随右值出现调用漂移）。
  - 调用段：`shutil.rmtree(...)`，无参写 `path.unlink()`（同样去 self/裁路径）
  - 流控制：`return ...` / `raise ...`
  - 均无法识别时退化为首行代码文本（截断 60 字符）。
- 垃圾代码退化为"整个函数一段"，无害。
- **按语言分派**（2026-08-11）：语言相关判定（续行/结构关键字/定义/命名链/签名边界）按语言各写一组函数——`core/lang/` 每语言一个模块实现 `LanguageSyntax` 四件套（isContinuationLine/isKeywordLead/classify/findBodyStart），`syntaxFor(languageId)` 整组分派。专组覆盖 TS/JS（含 react 方言）、Python、Go、Rust、Java、C#、C/C++（同组）、Ruby、PHP、Swift、Kotlin，未知语言退 generic 混合组（即原语言无关启发式，行为不变）；新语言加模块 + 注册 id，不改算法。专组顺带修掉混合表的跨语言误判（JS 的 `match = …` 被认成 switch、`end = …` 被 Ruby 续行词粘段等），并携带各语言的语义映射：Go 的 select、Kotlin 的 when、Ruby 的 case 归 switch；C# 的 using/lock、Java 的 synchronized、Swift 的 defer 归 with；Swift 的 do/catch、Ruby 的 begin/rescue/ensure 归 try；Ruby 的 unless/until、Swift 的 guard/repeat 各归 branch/loop。Python 的 `match`/`case` 与 TS 的 `using` 是软关键字，用 lookahead 排除赋值/调用形态；Ruby 无签名开口符，findBodyStart 认"括号闭合的首行"。语言中立的表达式工具（statementSummary/condenseHeader/签名深度扫描）共享在 `lang/expression.ts`。
- **函数体提取**（`extractBody`）：签名边界归语言组（`findBodyStart`）——逐行累计括号深度（字符串遮蔽后），brace 语言认"行尾 `{` 且深度回到 1"，colon 语言认"行尾 `:` 且深度 0"，generic 先到先得——TS 解构参数 + inline 类型字面量的多行签名因此不再被切进函数体；扫描窗口 8 行，括号未闭合时顺延。尾部闭合行裁剪语言无关，留在 `segmentation.ts`。
- 纯函数实现（`core/segmentation.ts`），按文档版本缓存。
- 消费方：聚光灯二/三档、`Go to Segment` QuickPick、侧边栏 **Segments 视图**（随光标显示当前函数的段落树，按 kind 显示彩色图标：branch=黄/loop=绿/try=红/definition=紫/assignment=橙/call=蓝；不显示行号）。
- **Segments 视图随光标联动**（2026-07-09）：光标移动时 `TreeView.reveal` 选中光标所在最深段（`focus: false` 不抢焦点；树处于骨架折叠的收起态时跳过，避免 reveal 展开祖先并经 syncCodeFold 反向展开刚折叠的代码）。聚光灯开启时视图同步亮暗：lit 集合之外的段以 `FileDecorationProvider`（自定义 scheme `sightread-seg` 的 resourceUri）染 `list.deemphasizedForeground` 并置灰图标，光标段的 label 用 `TreeItemLabel.highlights` 强调——树条目无法比默认前景更亮，"点亮"只能靠压暗其余部分表达，与编辑器同构。
- ~~Outline 注入~~（**已实证失败，2026-07-07**）：provider 内调 `executeDocumentSymbolProvider` 会与 VS Code OutlineModel 的 in-flight 请求合并机制形成循环等待，Outline 永远 loading。"既消费又提供符号"结构性走不通，按预留退路改为侧边栏 TreeView。

### 3.5 聚光灯（spotlight）

三档退化阶梯，每档只比上一档多一个数据依赖：

| 档 | 焦点集合 | 依赖 |
|----|---------|------|
| 1 Function | 当前函数；函数外重灰 | DocumentSymbol |
| 2 Segment | 基于段落树的四档着色（见下） | + 自动切段 |
| 3 Segment+Var | 二档 ∪ 当前 symbol occurrence 所在的最深节点 | + 变量染色 |

**四档着色**（2026-07-07 第二版，随段落树递归化引入）——光标落在树的某个节点上时：

| 亮度 | 范围 | opacity 设置 |
|------|------|--------------|
| 最淡 | 函数外部 | `functionDimOpacity` (0.15) |
| 次淡 | 函数内非祖先、非兄弟的部分 | `segmentDimOpacity` (0.4) |
| 再次 | 光标节点的兄弟节点 | `siblingDimOpacity` (0.6) |
| 最浓 | 自己 + 全部子孙 + 相关节点（occurrence 所在最深节点）+ 祖先首行与函数首行（上下文锚） | 1.0 |

- 切段失灵（无段落/光标在段落间隙）→ 自动退化为一档行为。
- 光标驱动 + 防抖（~120ms）；焦点抖动的保持策略留待原型体感调参。
- 入口在 **Segments 视图标题栏的 👁 按钮**与**状态栏的 👁 项**（显示当前档位，点击开档位选择器）；当前档位常驻 **Segments 视图的 message 行**（`◈ Seg+Var · ↖ in function` / `◇ Off · ↖ outside function`——◇/◈ 一对认 spotlight 开关：空心=Off、菱中带点=聚焦中；↖ 认光标字段；TreeView.message 是纯字符串、不渲染 codicon；◉/○/◎ 圆形字形与字母难分、彩色 emoji 与 codicon 图标语言相抵、眼睛字形连 U+FE0E 都压不住照样出彩色，均实测被否）。
- `sightread.spotlight.defaultMode`：启动时应用的默认档位（off / seg+var / seg / fn，默认 off）。

### 3.6 入口点（entry points，2026-07-09；2026-08-11 视图退役为引擎）

- **动机**（原 doc/inbox 想法）：列举出当前文件所有的"入口"——所有会 export 出去、被外界调用的函数/类/变量。先列举，之后直接顺着引用往下看，再做筛选——给阅读一个文件的路径指出一条明路：从入口开始读，而不是从第一行开始读。
- **呈现（2026-08-11 重定）**：侧边栏视图砍掉——它只有"我知道实现在这个文件里，想一步步读懂"这一个使用时刻，配不上一个常驻面板。分类引擎保留，两个消费面：
  - **CodeLens**：每个入口声明行上方一行 `» entry — 3 external refs`（疑似入口 `» suspected entry — no refs found`），点击 peek 该符号的引用（装饰 gutter 图标做不了 tooltip/点击，是 VS Code 的多年开放缺口，CodeLens 是唯一能挂信息又能点的编辑器内通道）。`sightread.entries.codeLens` 可关。
  - **`Go to Entry Point…` QuickPick**：按需列表，entry 在前、suspected 分区在后，边扫描边流式填充。
  - 成员懒分类（类方法逐个展开）随视图一并退役——CodeLens 只标顶层符号。
- 每个顶层符号按**引用位置**分类（`executeReferenceProvider`）：
  - 有文件外引用 → **入口**；
  - 有来自**其他符号 body 内**的同文件引用（wrapped）→ 隐藏——存在更抽象的包装者，读者应从包装者读起；
  - 只有来自**模块顶层代码**的同文件引用（script ref）→ **中性证据**：调用者是脚本本身，不是读者可以改从其读起的符号，故既不降级也不升级，落到语法提示/疑似入口路径（描述显示 "called at top level"）；
  - 找不到任何引用 → **疑似入口**，弱化显示（`activate` 这类框架钩子、路由 handler，或死代码），`sightread.entries.showSuspected` 可关。
- **发布行**不算调用：`export { … }` 子句、Python `__all__`、以及 Python `__main__` guard 块内的调用（`if __name__ == '__main__': main()` 是"向运行时发布入口"的语法，与 export 子句同族；按缩进向上找 guard，与 Go `main`/`init` 声明侧特例对称）——均记为声明公开证据，`main` 因此是正式入口（描述显示 "script entry"）。
- **语言语法提示**（`sightread.entries.languageHints`，默认开）细化"无引用"情形：`export`/`pub` 关键字、`export { … }` 子句、Python `__all__`、Go 大小写、前导下划线命名——声明公开的升为入口，声明私有的丢弃。
- **导入名永不是入口**（其引用属于原符号），除非文件刻意再发布（`export { x }`、`__all__`）——barrel 文件与 `__init__.py` 因此保有入口。
- 扫描由 CodeLens 请求驱动（VS Code 只对可见文档发起请求，天然的可见性门控），按文档版本缓存；编辑时先展示旧 lens、1.2s 防抖后重扫，引用查询完成即流式刷新（`onDidChangeCodeLenses`）。

### 3.7 阅读轨迹（trail，2026-07-14）

- **动机**：现有功能都在单文件/单函数尺度辅助阅读，缺少函数与函数之间调用关系的表达。其他插件的做法是全量扫描（LLM 或 language server）生成外部文档 / WebView——慢、有成本、排版非标准化。Trail 反其道：**用户自然阅读，结构自然显现**——读者的 drill-in 与引用跳转本身就是调用结构的发现过程，走过的路即地图。
- **数据是图，视图是树投影**（`core/trail.ts`）。调用关系本质是 DAG 且可能有环，树状存储表达不了（Navigation History 的教训：模型与视图不分离，导致"调用方成为父节点"做不到）。节点 = 函数/方法/类/模块（script 顶层代码归模块节点），边 = "调用方 → 被调方"，边上存**已知最早**的 callsite 行。树投影每次渲染现算：被多个调用方调用的函数在每个调用方下都出现（镜像节点懒展开、共享子树），环沿祖先链截断为 ↻ 叶子；纯环成分无严格根时按创建序补根。ref-jump 发现调用方 ⇒ 被读函数自动不再是根——**re-root 是图的自然结果，无需特判**。子节点按 callsite 升序排列 = 被调方在父函数叙事中的出场顺序。
- **节点永远是落点的 enclosing symbol**，不是光标下的任意 symbol（Navigation History 的变量污染从源头消失）。`vs/symbols.ts` 在同一次 DocumentSymbol 查询里多算第三种语义 `at`：最内层符号、**头行算符号本身**（区别于聚光灯的头行让位），并携带 kind/名字范围/容器名。
- **边只由已验证的结构性跳转产生**（precision-first，`core/jumpClassify.ts`）：
  - **drill-in**：落点在某符号自己的名字上，且出发点的词 == 该符号名（去参数表，C 族符号名带参数表）→ 出发 scope 调用落点符号；
  - **ref-jump**：落点的词 == 刚读符号名，且不落在任何定义的名字上 → 落点 scope 调用该符号（调用方成为父节点）；
  - 识别的是**语义签名而非输入手势**：F12 / Cmd+Click / peek 选择 / 肉眼找到后点击，一视同仁；同一行内的移动永不算跳转；重复点击已在名字上的符号不算自调用，但从体内调用点跳到自己头上是递归；
  - 候选边须经**单次 definition provider 验证**才入图（drill-in 验出发词的定义确在落点符号；ref-jump 验落点词的定义确在刚读符号）——跳转刚用过 provider、缓存是热的，毫秒级。验证失败静默丢弃，宁缺毋滥。其余一切跳转（Ctrl+Tab、搜索结果、面包屑……）全部忽略。~~召回缺口由 `Pin Current Function to Trail` 显式命令兜底~~（2026-08-11 删除，理由见"激活与生命周期"）。
  - **出发点在快手势下不会 settle**（2026-07-14 实测教训）：Cmd+Click、"点击调用词后立刻 F12"都在防抖窗口内连发两个 selection 事件，出发点的 settle 被防抖吞掉或被管线令牌作废——settled-pair 分类天生看不见它。两层修复：① settled 状态即使被管线作废也照喂 trail（对渲染是过期数据，对 trail 恰是出发点）；② trail 自持一条**原始光标轨迹**（每个 selection 事件同步记 uri/行/词，零查询，16 条环），settled 分类无果时回退：落地在符号名上 + 轨迹中最后一个不同行状态（3s 窗口内）的词等于该名 → 补解析出发点的 enclosing symbol（其文档必然还开着）→ 同样的 definition 验证 → 入图。ref-jump 不需要此回退：找引用的出发点是驻留状态（peek 打开与浏览的时间远超防抖），天然已 settle。
- **激活与生命周期**：
  - **仅视图可见时记录**（entriesView 的 watching 门控同款）；录制中 ⇔ 面板可见，面板即状态指示器，不设状态栏图标。
  - 规则的不可见靠两层消解：① `viewsWelcome` 空态文案在"打开面板发现是空的"这个惊奇现场解释规则；② 隐藏期只把 settled 状态推入**小环形缓冲**（12 条 / 3 分钟窗口，管线现成数据、零查询），视图打开时回放缓冲——"刚才那几跳"当场显形，也顺带桥接 visible 在切侧栏时的闪断。
  - 标题栏（2026-08-11 精简）：🗺 规划路线（§3.8.3）+ Collapse/Expand All（动态互换，仅树、不碰编辑器折叠），溢出菜单 `Clear Trail`（连 route 注册表全清——trail 与 route 不再分开清理，用户分不清两者的边界）。⏸ 暂停按钮删除：录制只由已验证的结构跳转产生、编辑代码不会添项，Navigation History 的"防自动垃圾"动机在这里不成立；误录靠右键单删兜底。Pin 同时删除：首个跳转自动产出 root+子节点，显式播种无独立价值（无 LSP 语言的召回缺口接受——那种环境下所有功能同瘫）。右键单删节点（连带只有它能到达的子孙；共享的幸存）与 `Go to Call Site`（跳到父节点中的调用行）。
  - 头部两通道（2026-08-11 统一分工）：description = `Route: <label>`（选中节点所属路线，否则最近一次种入的）；message = 徽标图例 `★ core · ↻ recursive · ↙ call site`，树非空时常驻——Trail 的 description 徽标最隐晦，图例值得一行常驻位。
  - **纯内存、不持久化**（原则 2：标注是短命的），杜绝历史堆积；300 节点兜底上限，按**整树最近访问时间**驱逐、永不动最活跃的树。
- **重要性显示，无任何行为计数**——visitCount 被否决：settle 计数度量的是光标抖动习惯而非重要性，dwell time 同罪（午饭问题）。替代为两个无噪声来源：
  - 客观 = 图拓扑：由树形自然可见——共用函数在每个发现它的调用方下镜像出现，出度与探索深度即子树形状。~~入度 ≥2 的节点 description 显示 `↗ n callers`~~（2026-08-11 删除：想看调用方，点进定义查 reference 一步即达，徽章无谓占用 description）；
  - 主观 = 荧光笔联动：函数体内有 marker 的节点 label 染 marker 色（FileDecorationProvider，自定义 scheme `sightread-trail`，与 Segments 视图同构）——重要性由人判断、由图定位；不另设 pin/star 判断通道（语义正交：判断属于荧光笔）。
- **显示通道分配**（2026-07-14，2026-08-11 修订）：label = 从属 + 名字——方法显示为 `ClassName.method`（containerName 本就在节点身份 key 里，只是补上显示；嵌套函数显示为 `outer.inner`，同为真实从属）。从属是主要阅读信息（"当前函数调用了哪些**类**的方法"），占主通道且参与树的 type-to-filter。description = **occurrence 级**徽标：★（路线 core 节点，§3.8.3）、↻ 递归、`↙ L88`（本次出现在父函数中的调用行——**点击到不了的位置必须可见**：点击到达的是定义，callsite 只有这里能看到；配套右键 `Go to Caller Site` 一步跳达。同一函数的不同镜像出现各有各的调用行，恰是 occurrence 级信息归 description 的理由）。**不显示文件名**——定义位置是点击随手可达的信息，降级到 tooltip（`相对路径:行号` + 路线 note）。label = 身份与从属、description = 出现位置的徽标、tooltip = 定义位置与备注。
- 光标 settle 在已有节点内 → touch + `reveal({select, focus:false})` 跟随；视图展开时光标若已停在某节点内也补一次 reveal（只 reveal 不 touch——可见性变化不该转正 planned 节点）；光标不在任何节点内则不动（不清选中、不跳）。根排序按创建序倒序（新树在上），刻意**不**按访问时间排——阅读中实时重排会晃。
- 编辑漂移：节点 key 不含行号（uri + 容器名 + 名字），range 信息每次到访自愈；跨文件跳转落点符号未就绪（LS 冷启动）给 600ms 宽限再解析一次，仍无则按模块语义处理。
- v2 预留：右键节点按需 call-hierarchy 扩展；与 Entry Points 联动（从入口开始读时自动种根）。"机器补的边用暗色区别于亲脚走过的边"已由 AI 路线落地（§3.8.3）。

### 3.8 AI 辅助层（解读 2026-07-30；路线 2026-08-11）

AI 不代读，只提供信息增益。两个形态——**解读**（局部："这段代码怎么读"）与**路线**（全局："为了这个目标，从哪开始读、顺什么链读"）——共用一套 agent harness 与同一条哲学：**note 是路标不是转述**，说角色与存在理由，永不复述代码做了什么（读者自己会读）。

**3.8.1 agent harness（机制）**

- 复用用户已有的 coding-agent CLI，headless 单发运行（订阅即用，不经手 API key）。`HarnessProfile { command, args（${prompt} 占位，缺省走 stdin）, exploreArgs?, env?, resultField?, errorField? }`；内置 claude / codex / opencode / pi / cursor（`cursor-agent` 别名探测，主名 `agent` 太泛）/ devin（Cognition 官方 CLI，Windsurf 血统；Windsurf 本体无 headless CLI）/ aider / agy（即 Antigravity）。`sightread.guide.harness = auto` 按市场份额序探测（Cursor 宿主提前 cursor）；`customHarnesses` 同名整体覆盖、不做字段合并。
- 两档 argv：**解读档**（无工具、单轮——代码随 prompt 附上）与**探索档 `exploreArgs`**（只读工具、多轮，路线专用；claude/codex/opencode/devin/agy 内置，未声明探索档的 harness 对路线明确报"不支持"）。
- `sightread.guide.model`：统一以 `--model <value>` 追加到两档 argv（八家 builtin 共享该 flag；值的词表属于所选 CLI），留空 = 各 CLI 默认模型；进度条 title 显示 `· <model>` 或 `(default model)`，让"没设"可见。
- prompt = 模板（按单位/场景，settings 可换）+ **恒定 JSON 契约收尾**——永远追加在最后、声明冲突时获胜，解析器只依赖契约。响应解析带容错阶梯（裸 JSON → ```json 围栏 → 首尾大括号截取）。
- 时长反馈：进度条 1s 秒表 `typically ~Ns · limit Ns · elapsed Ns`（恒定前缀 + 末尾计数——变化的前缀会让通知反复重排换行）；typical = 每个 `harness/单位` 键最近 10 次**成功**运行的中位数（globalState，超时与取消不计），首跑用经验先验（解读 60s / 探索 120s）。
- 可观察性：**"SightRead" Output channel**（共享，extension.ts 创建）记录每次 AI 运行——解读与路线一视同仁（2026-08-11 补齐解读侧）：原始回复、解析结果或失败原因、路线的 hop 丢弃/落根/退行号记录——结果长歪时能区分"AI 答成这样"与"好答案被解析掰坏"。

**3.8.2 AI 解读（guide）**

- 三个解读单位 function/class/file：光标层级自动判定（最内函数 → 所在类 → 文件），选区取完整覆盖的最小单位。
- 产出 = 就地标注的角色步骤（行区间 + role + note）：函数分结构层（main/setup/fallback/special）与实体层（entity，上限 9——7±2 工作记忆上限）；类按成员（entry/helper/util/lifecycle/state）；文件按顶层块（config/types/core/wiring/util/exports）。steps 恒按行序——"导读顺序"因千人千面被否决。
- role 词表开放（自定义模板可造新 tag）⇒ 显示过滤必须数据驱动；2026-08-11 起过滤域并入统一 accent key（§3.2）——手动五色与 role 同一个 Filter Marks 面板、同一个隐藏集，单一来源在 compositor，全局生效。
- 解读是短命的，且随 2026-08-11 的模型合并改为**逐步骤存亡**（§3.2）：编辑碰到哪个步骤删哪个，其余各自平移，壳随最后一个步骤消亡——此前的 wholesale（单位内任何编辑删除整份解读）过于暴躁且与手动标记规则相异。新解读仍顶掉与之 envelope 重叠的旧解读（函数解读顶掉文件概览）。存储并入统一 mark 仓库（workspaceState），渲染挂 Markers 视图 ✦ 节点 + 编辑器就地着色。

**3.8.3 AI 阅读路线（route / trace）**

- **动机**：全局阅读指引此前靠搜索和猜。两个场景：**A（Find Logic Routes，2026-08-11 自 Plan Reading Route 改名——找的是逻辑路径不是"阅读"）**输入阅读意图 → 从入口顺到实现的路线；**B（Trace Entries）**光标处代码 → 反向列出**全部**到达它的入口及各自的链。A 的 prompt 附带光标所在符号（文件、名字、行区间，与 B 的查询同构）——目标里写"它/this"而不点名时有确定指代物，否则 agent 只能猜或拒答。
- **答案的形状就是 §3.7 的图**：agent 在 workspace 根只读探索后输出 hop 树，种入 TrailGraph 作 **planned** 节点/边（暗色）。不建新视图——路线的目的就是被走，计划与足迹必须画在同一张地图上，走到哪一步、在哪走岔一目了然。
- **契约要点**：hop = `{file, symbol, container?, kind, line, note, core?, calledBy?, callsiteLine?}`。hops 数组顺序**不携带语义**（steps 行序的同一教训），结构只来自 calledBy；坏引用/成环在解析器确定性落根。`core: true` 语义标注（A = 真正实现目标的 meat、B = 每个入口）→ 渲染为 ★——序号徽章被否决（进深已表达顺序，个人化的阅读次序不标）。每树 ≤12 跳；**树数不设限**——入口列表必须完整，被砍掉的入口是 surprise；解析器 60 跳硬保险只防跑飞。找不到目标 → 空 hops + summary 说明，原样展示为 "no route — …"。
- **转正规则（到达即点亮）**：planned 节点被 touch/upsert（光标落入、点击树条目皆算）即转正，亮暗**只跟节点不跟边**——曾按"边未走过则该出现位置保持暗"渲染，点击后毫无视觉反馈，废弃；真实跳转把 planned 边转正并用实测行号替换 AI 猜的 callsite（未知 callsite 存哨兵值：排序垫底、不显示）。已走节点被路线覆盖时绝不变暗、自愈位置不被 AI 数据覆盖，只取路线徽章。
- **多路线并存**：路线是实体（id + label），新路线不替换旧的；view.description 显示**选中节点所属路线**（否则最近一次种入的）。清理只有一个出口：`Clear Trail` 足迹与路线全清——~~`Clear Routes` 单独清 planned~~（2026-08-11 删除：用户分不清 trail 与 route 的边界，两个清空按钮只制造困惑）。planned 免驱逐（与 pinned 同款豁免），纯内存（原则 2）。种入按结构先序**倒序**建节点——配合"新者在上"的根排序，路线的根以第 1 跳在顶正序显示。
- **hop 定位**（vs 层）：openTextDocument + DocumentSymbol 按名匹配（container 命中优先、离 AI 行号提示近者次之），节点 key 与真实行走的构造逐字一致——走到即经 upsert 点亮；找不到符号退 AI 行号提示、留暗待走亮或 Clear Trail；绝对路径/含 `..` 的 hop 丢弃，引用者落根。

## 四、架构

```
src/
  core/            纯逻辑，零 vscode 依赖，单元测试覆盖
    segmentation.ts   切段算法 + 函数体提取（结构骨架，语言判定经 LanguageSyntax 委托）
    lang/             每语言一组语法函数实现 LanguageSyntax：tsJs/python/go/rust/java/
                      csharp/cCpp/ruby/php/swift/kotlin + generic 兜底，
                      index.syntaxFor 按 languageId 整组分派，expression 是中立表达式工具
    marks.ts          统一标记数据操作（accent/编辑平移/相交删除/guide 壳与 envelope）
    focus.ts          焦点集合计算、行区间代数（merge/subtract/contain）
    enclosing.ts      "当前函数"选择（显式命令取最内层 vs 聚光灯的头行让位）
    entries.ts        入口点分类（引用位置 + 语言语法提示）
    trail.ts          阅读轨迹图模型（节点/边/树投影/环覆盖/删除与驱逐 + planned 路线）
    jumpClassify.ts   结构跳转分类（drill-in / ref-jump 的语义签名识别）
    guidePrompt.ts    解读 prompt 组装（单位模板 + 恒定 JSON 契约）
    guideParse.ts     解读响应解析（容错阶梯 + 步骤校验裁剪）
    routePrompt.ts    路线/溯源 prompt 组装（两场景模板 + 共用契约）
    routeParse.ts     路线响应解析（calledBy 解链/断环/落根 + 丢弃记录）
    harness.ts        agent harness profile（内置七家 + argv 组装 + 结果抽取）
    runStats.ts       harness 运行时长统计（中位数 typical）
  vs/              平台层
    compositor.ts     唯一渲染出口：装饰类型注册 + 图层/模式合成（accent 单通路）
    symbols.ts        函数查找（executeDocumentSymbolProvider，两种语义见 core/enclosing）+ 按名定位（路线播种）
    segmentCache.ts   按文档版本缓存的切段结果
    highlighter.ts    标记命令（五色直达 + 选色/带注）+ 编辑跟踪
    variableTint.ts   occurrence 获取与降级
    spotlight.ts      聚光灯档位状态 + 焦点计算入口
    skeletonFold.ts   折叠命令对
    segmentsView.ts   Segments 树视图（光标联动 + 亮暗镜像）+ Go to Segment
    markersView.ts    Markers 树视图（按文件分组，guide 壳 + loose 标记行序混排）
    entries.ts        入口点引擎：CodeLens + Go to Entry Point QuickPick（无视图）
    trailView.ts      Trail 树视图（记录器 + LSP 验证 + 可见性门控 + 回放缓冲 + 路线播种/点亮）
    agentCli.ts       harness 探测与 headless 驱动（spawn/超时/取消）
    guideFeature.ts   AI 解读命令流（目标解析 → prompt → 进度 → 入库渲染）+ Filter Marks
    routeFeature.ts   AI 路线命令流（goal/光标 → 探索运行 → hop 定位 → 种入 trail）
    markRepository.ts 统一标记仓库（workspaceState）+ 旧双 key 迁移
    palette.ts        accent 调色板与 swatch/gutter 图标生成
  extension.ts     事件接线：统一的光标管线（防抖 + 过期令牌），文档变更分发，共享 Output channel
```

统一光标管线：`selection 变化 → 找函数 → 喂 trail/各视图 reveal → 算 tint → 算段落 → 算焦点 → compositor.render`。中途文档/光标再变则丢弃（令牌失效）。settled 状态是唯一数据源：trail 记录器与 Entry Points / Markers / Segments 三个视图的光标跟随都消费它。

存储两处：统一标记仓库（workspaceState，单 key `sightread.marks`；2026-08-11 由 markers/guides 双 key 合并，首次激活自动迁移），harness 运行时长（globalState——时长属于本机的 CLI，不属于某个 workspace）。段落是带缓存的现算，变量染色和折叠零存储，阅读轨迹与 AI 路线纯内存（关窗即弃）。
可观察性：一个 **"SightRead" Output channel**（extension.ts 创建、Guide/Route 两个 feature 共享）记录每次 AI 运行——解读与路线一视同仁：原始回复、解析结果/失败原因、hop 丢弃记录。

## 五、UI 面规范（2026-08-11 定）

这轮 UI 规范化沉淀的横切规则，改任何 UI 面前先对照本节。

- **命令命名**：动词开头祈使式；括号只保留 `(AI)` 一种用途；结尾 `…` 当且仅当会先弹选择/输入（AI 命令除外，`(AI)` 已表明对话流程）；`Remove` = 删指定对象、`Clear` = 清空集合；冒号家族仅用于同一动作的枚举变体（`Spotlight: X`、`Mark Selection: <Color>`）；view item 菜单用短名——上下文已知则省略宾语（`Mark…`、`Fold Inside`）。
- **View 头部两通道**：description = 在看什么（Segments=函数名、Trail=`Route: <label>`、Markers=空）；message = 状态偏离或图例（Markers=`⊘ N hidden`、Trail=徽标图例、Segments=`◇/◈ 档位 · ↖ in/outside function`，◇=Off、◈=开）。message 是纯字符串——不渲染 codicon，图形只用**贴近 codicon 风格的单色线形字形**（★ ↻ ↙ ↖ ◇ ◈ ⊘ 一族）；圆形小几何符号（◉ ○ ◎）与字母/数字难分，emoji 一律不用——眼睛字形带 U+FE0E 在部分字体链下照样渲染成彩色，实测被否。message 非空会压制 viewsWelcome，所以"无偏离"时必须置 undefined，不许留空转态文案。
- **标题按钮**：排序 AI/主动作 → 新建/标记 → 模式开关 → 过滤 → 树折叠；破坏性动作一律入 "…" 溢出菜单；状态切换用动态互换按钮对（fold/unfold、filter/filter-filled）；图标一律单色 codicon。collapse/expand-all 只给"深度 ≥2 且默认展开"的树（Segments 的 fold 对是其超集且同步编辑器，不叠加原生 collapse-all）。
- **空态（viewsWelcome）**：两行、零按钮：第一行本体功能，第二行 AI 功能并指向上方按钮。welcome 里 codicon `$(icon)` 可渲染，行首图标必须与所指的标题按钮**同一 codicon**（Markers 第一行 = `$(note)` 即 Mark with Note 按钮、第二行 = `$(sparkle)`、Trail = `$(map)`）；**整行只有一个链接会被渲染成按钮**，故禁止整行链接，行内链接可用。**键位一律不写死**——welcome 无键位替换语法，静态键位在用户改绑后即错；要引导键位就放行内链接 `command:workbench.action.openGlobalKeybindings?["sightread"]` 指向实时键位页。walkthrough 有 `kb(commandId)` 宏（渲染当前实际键位、自动分平台），那边用宏。空态按钮是强引导，只留给明确要引导点击的场景（当前无处够格）；临时性空态走 message 一句话。
- **快捷键**：统一 `Ctrl/Cmd+K` 前缀 chord 家族：`1–5` 五色直标、`C` 选色、`N` 选色+note、`⌫` 删选区标记、`G` 解读、`L` 聚光灯、`[` `]` 骨架折叠。新键先查 VS Code 默认 chord 表（`K M`/`K R`/`K O` 等已被占）。
- **item 右键菜单**：组序 导航 → 标记/编辑 → 视图操作 → 删除（垫底）；inline 图标只有垃圾桶、只出现在"item 本身是可删对象"处。
- **树 item description 语法**：`[状态符号] · [L位置] · [文本/预览]`，分隔符 ` · `，位置 `L12` / `L12–20`。
- **"被标记"的三层视觉**：swatch 图标 = 身份（item 就是那个标记）、label 染色 = 属性（item 覆盖被标记的代码）、gutter 竖条 = 位置（编辑器内）；色板三处同源（PALETTE / contributes.colors）。
- **色板（2026-08-11 定稿，双带可选）**：十二 accent（手动 5 + 角色 7）取同一条 oklch 带，逐色域映射（降彩度）到 sRGB，每个 accent 双主题 `AccentPaint { dark, light }`。两条带由 `sightread.palette` 选：**vivid**（默认，深 `L .79 C .15` / 浅 `L .50 C .14`）与 **soft**（深 `L .76 C .11` / 浅 `L .46 C .11`；plumbing 均近灰）。编辑器装饰（行背景 0.12 / 尺标 / gutter 竖条 / note 文字 0.85）走 DecorationRenderOptions 的 `light:`/`dark:` 分支，切设置时 compositor 重建 accent 装饰对（refreshAccentTypes，与 dim 档同款模式）；swatch 图标出 `{light, dark}` URI 对、按 item 现取现建，跟随设置。**树 label 是唯一切不动的层**：FileDecoration 只吃 ThemeColor，contributes.colors 的默认值静态钉在 vivid（同色相、仅明彩度差，soft 下违和很小；要全 soft 用 workbench.colorCustomizations 覆盖）。修掉旧版"浅色主题沿用暗色板"的硬伤。改带只动 palette.ts 的 BANDS；透明度动 compositor。
- **Settings**：configuration 用分节数组、节与节内按使用频率排 order；描述一律 markdownDescription，写清作用、默认值含义、何时需要改；enum 必带 enumDescriptions。

## 六、已知风险与待实证项

1. **切段质量**跟随代码质量——设计上已接受，垃圾代码退化无害。启发式参数（块长阈值等）待真实代码调参。
2. ~~Outline 注入的 provider 合并行为~~——已实证失败并移除（死锁，见 §3.4），段落与荧光笔列表由侧边栏视图承载。
3. **聚光灯三档的焦点抖动**——v1 只做防抖，保持策略待体感。
4. **函数体提取**对非常规签名（多行签名、装饰器）是启发式，接受误差。
