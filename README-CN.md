<p align="center">
  <img src="./media/icon.png" width="120" alt="SightRead icon">
</p>

<h1 align="center">SightRead</h1>

<p align="center">
  Vibe coding 时代的代码强化阅读器，专注于强化代码的微观阅读。<br>
  高亮、标记、一键折叠反折叠、代码段视觉强化——让你<b>就地</b>读懂代码。
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=WaylongLeon.sightread"><img src="https://vsmarketplacebadges.dev/version/WaylongLeon.sightread.svg?label=VS%20Marketplace&amp;color=007ACC" alt="VS Marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=WaylongLeon.sightread"><img src="https://vsmarketplacebadges.dev/installs-short/WaylongLeon.sightread.svg" alt="Installs"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=WaylongLeon.sightread&amp;ssr=false#review-details"><img src="https://vsmarketplacebadges.dev/rating-star/WaylongLeon.sightread.svg" alt="Rating"></a>
  <a href="https://open-vsx.org/extension/WaylongLeon/sightread"><img src="https://img.shields.io/open-vsx/v/WaylongLeon/sightread?label=Open%20VSX" alt="Open VSX"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/pyeprog/sightRead" alt="License"></a>
</p>

<p align="center"><a href="README.md">English</a> | <b>简体中文</b></p>

## 💭 为什么

<p align="center">
  <img src="./media/babel-towel.jpg" alt="babel">
</p>

> 不读代码的人无法掌控产品的走向，无法控制项目的质量，无法学到任何东西。

你让Agent来写代码，但如果不读这些代码，那他写什么就跟你毫无关系。
Idea is cheap, code is even cheaper these days. AI is your tool, not your master. And what still matters these days is your experience of your own adventure.

诚然，读或不读代码，很多时候并不是一个问题，只不过是一种价值选择。
而这个插件，给那些仍旧想要阅读代码的人提供一些视觉上的辅助，希望它能帮你读得更快，读得更顺。

现在人类不是代码生产的大头，机器才是。阅读代码理解并做决策是当下的瓶颈。当海量代码放在你眼前，LLM能帮你梳理大结构和框架，但不能帮你细读（读细节代码和读LLM给的summary，成本相同）。
SightRead走相反的方向，无需LLM辅助，强化“人的阅读能力“本身，在你的代码上附上一层视觉辅助（可随时开关），让你像音乐家一样，看到code，逻辑图景就能自然浮现。

<p align="center">
  <img src="./media/solennelle.webp" alt="solennelle">
</p>

## ✨ 功能

<p align="center">
  <img src="./media/demo.webp" alt="demo">
</p>

五个正交的功能，各自提供不同的视觉辅助（见 design.md §2）：

- 🦴 **骨架折叠** —— 快速折叠与展开函数内已有的代码块。读函数时，可以先折叠看函数的大结构，对感兴趣的代码块再展开仔细阅读。
- 🖍️ **荧光笔（标记）** —— 对于一些难读的、 tricky的代码块，可以先用荧光笔打个标记，也可以在这个标记上写下一个简短的note，标注它是干啥的。
- 🎯 **变量描边** —— 在函数的上下文里面，把当下光标指向的symbol标出来，方便看当下这个变量是在哪里创建的，又在哪里使用的。
- 🔦 **聚光灯** —— 排除其他函数、其他无关代码块的视觉干扰。点击状态栏的 👁 按钮，从列表里选一个档位。
  1. **Function** —— 只看当前函数，其他函数一律dim
  2. **Segment** —— 只看当前代码块，其他代码块一律dim
  3. **Segment+Var** —— 只看当前代码块和相关代码块，其他代码块一律dim，这个模式我用的最多。
  4. **Off** —— 关闭聚光灯，默认模式。
- 🧩 **自动分代码块** —— 按空行 + 关键词把函数切成**递归结构**，方便在segment窗口展示函数大结构，点击可以跳转到相应代码块。节点旁还会以灰色小字显示压缩后的条件/表达式（悬停可看完整首行）。Segments 面板会跟随光标：光标所在的段自动选中；聚光灯开启时，无关的段在面板里也会像编辑器里一样压暗。
- 🚪 **入口点** —— 侧边栏视图，列出一个文件的控制流可以从外部进入的所有"入口"，让你从入口开始顺着引用往下读，而不是从第一行开始读。每个顶层符号按引用位置分类：被其他文件引用 → 入口；只在文件内被引用 → 隐藏；找不到任何引用 → 弱化显示的"疑似"入口（`activate` 这类框架钩子、路由 handler——或者死代码）。编辑器 gutter 里以雪佛龙（»）标出入口行。
- 🧭 **Trail（阅读轨迹）** —— 侧边栏视图，在它打开期间把你的跳转变成调用结构图：跳到定义，被调函数出现在出发函数之下；跳到引用，调用方成为父节点。不做全项目扫描、不用 LLM——只记录你真实走过的结构性跳转（每一条都经 definition provider 验证），结构随阅读自然显现。子节点按调用位置排序，被多个调用方走到的函数带 `↗ n callers` 徽标，函数体内有荧光笔标记的节点以标记色染色。轨迹只存在于内存中，关窗即弃。
- 🗂️ **侧边栏** —— SightRead 活动栏容器包含四个视图：**Entry Points**（从哪里开始读这个文件）、**Segments**（当前函数的段落树）、**Markers**（工作区内所有荧光标记）和 **Trail**（你走过的调用结构）。四个视图都会跟随光标。它们合在一起天然覆盖了 Outline 的功能——比起 Outline 不加筛选地列举所有 symbol，SightRead 能更好地向你展示当前阅读代码的真正结构。


## ⌨️ 命令

所有命令在命令面板中都以 `SightRead:` 为前缀；常用命令也在编辑器右键菜单（**SightRead** 子菜单）和侧边栏视图标题栏里。

| 命令 | 作用 |
|---|---|
| `SightRead: Fold Skeleton (Current Function)` | 折叠当前函数内的所有代码块，先看大结构 |
| `SightRead: Unfold Skeleton (Current Function)` | 再展开它们 |
| `SightRead: Mark Selection (Favorite Color)` | 一键用常用色打标记（`sightread.marker.favoriteColor`） |
| `SightRead: Mark Selection (Pick Color)…` | 给选区打荧光标记，选颜色 |
| `SightRead: Mark Selection (Color + Note)…` | 选颜色并附上可选的备注 |
| `SightRead: Add/Edit Marker Note` | 给光标处的标记添加/编辑简短备注 |
| `SightRead: Remove Markers in Selection` | 清除选区内的标记 |
| `SightRead: Remove Markers in Current Function` | 清除当前函数内的标记 |
| `SightRead: Remove Markers in File` | 清除当前文件内的标记 |
| `SightRead: Remove All Markers (Workspace)` | 清除工作区内的全部标记 |
| `SightRead: Choose Spotlight Level…` | 从列表选档位，等同点击状态栏的 👁 |
| `SightRead: Spotlight: Focus Current Function` | 直接切到 Function 档 |
| `SightRead: Spotlight: Focus Current Segment` | 直接切到 Segment 档 |
| `SightRead: Spotlight: Focus Segment + Variable Uses` | 直接切到 Segment+Var 档 |
| `SightRead: Spotlight: Off` | 关闭聚光灯 |
| `SightRead: Toggle Variable Tint` | 开关变量描边 |
| `SightRead: Go to Segment…` | QuickPick 跳转到当前函数的某个段 |
| `SightRead: Go to Entry Point…` | QuickPick 跳转到文件的某个入口点 |
| `SightRead: Refresh Entry Points` | 重新扫描当前文件的入口 |
| `SightRead: Pin Current Function to Trail` | 把当前函数作为根种入轨迹 |
| `SightRead: Pause Trail Recording` / `Resume Trail Recording` | Trail 视图开着时暂停/恢复记录 |
| `SightRead: Clear Trail` | 清空已记录的调用结构 |

## ⚙️ 设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `sightread.variableTint.enabled` | `true` | 光标移动时描边符号的所有出现 |
| `sightread.spotlight.defaultMode` | `off` | 启动时的聚光灯模式（off / seg+var / seg / fn） |
| `sightread.spotlight.functionDimOpacity` | `0.15` | 函数之外代码的压暗程度 |
| `sightread.spotlight.segmentDimOpacity` | `0.4` | 函数内无关代码的压暗程度 |
| `sightread.spotlight.siblingDimOpacity` | `0.6` | 光标所在段的兄弟段的压暗程度 |
| `sightread.entries.languageHints` | `true` | 用语言语法（`export`/`pub`、Go 大小写、`_` 前缀）细分无引用符号 |
| `sightread.entries.showSuspected` | `true` | 显示"疑似"入口（找不到任何引用的符号） |
| `sightread.entries.gutterIcons` | `true` | 在 gutter 中以雪佛龙（»）标出入口行 |
| `sightread.entries.iconColor` | `#8C8C8C` | 雪佛龙颜色；疑似入口以降低的透明度使用同色 |
| `sightread.marker.favoriteColor` | `yellow` | `Mark Selection (Favorite Color)` 使用的颜色 |
| `sightread.marker.notePosition` | `lineEnd` | 标记备注显示在行首还是行尾 |

## 🛠️ 开发

```bash
npm install
npm run compile     # 类型检查 + lint + 打包
npm run test:unit   # 快速纯逻辑测试（mocha）
npm test            # 在 VS Code 宿主中跑完整集成测试
```

在 VS Code 中按 `F5` 启动 Extension Development Host。

- `npm run watch` —— 增量构建（esbuild 与 tsc 类型检查并行）
- `npm run package` —— 生产打包

架构（见 design.md §四）：`src/core/` 是纯逻辑层（分段、标记运算、焦点代数 —— 有单元测试，零 vscode 依赖）；`src/vs/` 是平台层，**所有**装饰渲染都汇入唯一的 compositor.
