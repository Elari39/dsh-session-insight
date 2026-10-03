# dsh-session-insight

一个 DSH 练手插件：走通 **`sessionProjections` 投影 → `wire.view` → 客户端 `useProjection` → slot 卡片** 这条完整链路。

功能本身刻意做小：在输入框上方显示一条只读的**会话健康度**状态条 —— 步数、工具调用数、失败数、重复调用数、失败率。它**不重复**官方 `sessionStats`（那个回答"多久/多少次"），而是回答"这个会话健康吗"。

---

## 安装

本包既是 npm 包，也是一个 **dsh bundle**（`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`），三种装法任选。

### A. 从 npm（推荐）

```powershell
# 用 Desktop 自带的 CLI 绝对路径；PATH 上的旧 dsh 管不了新 profile
$dsh = "D:\Downloads\software\DSH\resources\runtime\cli\bin\dsh.cmd"

# 1) 装进目标 profile
& $dsh plugin --profile web add dsh-session-insight

# 2) 让 profile 真的加载它：编辑 ~/.dsh/profiles/web/package.json，
#    在 dsh.profile.bundles 数组里加上 "dsh-session-insight"
```

### B. 直接从 GitHub（没发 npm 时也能用）

```powershell
& $dsh plugin --profile web add github:Elari39/dsh-session-insight
```

### C. Desktop profile（Electron 独占）

`dsh plugin` 会拒绝 desktop profile（`profile "desktop" is managed exclusively by the Electron application`），
只能直接改 patch 文件：

```powershell
pwsh -File .\install.ps1              # 幂等，可重复跑
pwsh -File .\install.ps1 -Uninstall   # 卸载
```

> ⚠️ **任何插件操作前都要完全退出 Electron 应用。**

### 装完确认

重启后输入框上方应出现健康度状态条；也可以直接向运行中的 host 请求浏览器半的 bundle：
`/plugins/??dsh-session-insight/client.js&rev=<rev>` 返回 **200** 才算加载成功，
404 意味着 host 半没挂上（最常见原因是 loader 行指向了目录而不是 `index.js`）。

---

## 文件

| 文件 | 作用 |
|---|---|
| [index.js](<./index.js>) | Host 半：向 `ctx.sessionProjections` 注册 `sessionInsight` 投影单元 |
| [client.js](<./client.js>) | Client 半：向 `conversation.input.dock` 注册一张只读卡片 |
| [package.json](<./package.json>) | `dsh.bundle.patch` + `dsh.client` 双声明 |
| [cordis.patch.yml](<./cordis.patch.yml>) | 把插件插进 profile 的 patch 行 |

---

## 一、投影单元契约（全部从已安装包源码核实）

```js
ctx.sessionProjections.register({
  key: 'sessionInsight',
  stateVersion: 1,                 // 必须是非负安全整数；同 key 不同版本会被拒绝
  stateSchema,                     // zod（不是 schemastery！）
  init: (header, inheritedEventCount) => state,
  apply: (state, event) => state,  // 必须同步；不关心的事件必须返回同一个引用
  wire: { viewSchema, view },      // zod；省略 wire 则该单元仅 host 可见
})
```

来源：`@deepseek-ai/dsh-session-projection/README.md`（§Define a projection unit、§Register and read）、
`dsh-session-stats/lib/index.js`、`dsh-tool-todo/lib/index.js`。

**两个 schema 是 zod，不是 schemastery** —— 这是最容易搞错的一点。首方包确实同时用两者：
`Config` 用 `@deepseek-ai/schemastery`，而 `stateSchema`/`viewSchema` 用 `zod`
（`dsh-session-stats/lib/index.js:1` 是 `import { z } from "zod"`，
`dsh-tool-todo/lib/index.js:1-2` 两个都 import 了）。

**注册表真实的校验**（`dsh-session-projection/lib/index.js:68-101`）：只检查 `stateVersion` 是非负安全整数、
以及同 key 不能跨版本共享。所以版本号写错是最容易踩的运行时错误。

### 引用相等是契约，不是优化

注册表有两道 `Object.is` 闸门：

1. `apply` 返回同一个 state 引用 → 直接跳过 `wire.view` 计算；
2. `wire.view` 返回同一个引用 → 抑制发布。

所以本插件把**算好的 view 缓存在 state 里**（`view` 字段），只在可见计数器变化时才重算。
否则每次 `tool/result` 成功、`assistant/message` 记账这类**内部状态变化**都会向客户端发布一次
它看不见的变化。`dsh-session-stats` 的 `view` 每次返回新对象，是接受这种多余发布的写法；本插件做得更严格。

---

## 二、折叠的事件（每个字段都核实过，没有猜）

| 事件 | 用到的字段 | 来源 |
|---|---|---|
| `assistant/message` | `data.message.content[]` 里 `{type:'tool-call', id, name, arguments}` | `dsh-llm/lib/types/assembler.js:100-105` |
| `tool/call` | `data.callId` | `dsh-session/lib/index.js:830`、`types/invariant.js:87-89` |
| `tool/result` | `data.message.source.callId`、`data.message.isError` | `types/invariant.js:101-105`、`lib/index.js:862` |
| `step/end` | `data.turn` | `dsh-session-stats/lib/index.js`（注释说明它才是 step 生命周期的权威） |
| `turn/end` | — | 同上；首方也在这里清 `pendingCalls` |

**为什么工具名要从 `assistant/message` 取**：`tool/call` 事件只带 `callId`，
工具名和参数在 assistant 消息的 tool-call 块上。所以用 `callId` 把两者配对。
这也顺带解释了为什么重复调用检测能做：签名 = `name + "\0" + arguments`。

> `arguments` 是**原始 JSON 字符串**（`assembler.js:104`），不是解析后的对象 —— 直接拿来做签名最稳。

### 失败率怎么算

```
失败率 = 失败的 tool/result 数 ÷ 派发的 tool/call 事件数
```

两个已知口径边界，都是刻意的：

- **分母是「已派发」的调用。** 被 `ctx.tools.guard()` 拦下、根本没派发的调用不产生 `tool/call`，
  所以它既不进分子也不进分母 —— 这个数字反映的是「已派发调用的失败率」，不是「模型意图调用的失败率」。
- **重复调用是「连续」判定**，不是累计：`read a.txt` 中间夹了别的调用再回来**不算**重复
  （中间做过别的事，说明不是在死循环）。

### 显示的精度策略

投影里的 `failureRate` 保留三位小数，但**展示层**（client 半）另有一套策略，
因为百分比会**隐藏自己的分母** —— `8.3%` 无论是 `1/12` 还是 `1000/12000` 读起来都一样，
而会话早期比率摆动极大，一个小数位会诱发过度反应。

| 样本量 | 显示 | 例子 |
|---|---|---|
| `toolCalls === 0` | `—` | 还没跑过，不假装是 0% |
| `≥ 10` | 一位小数 | `17/198` → `8.6%`（旧版整数会显示 `9%`） |
| `< 10` | **原始分数** | `1/3`、`0/5`、`2/7` |

小样本用原始分数的好处：**精确**（不做统计推断）、**自带样本量**（分母就是证据）、
且能让等比的分数保持可区分 —— `1/3` 和 `1/6` 不会都塌缩成 `33.3%`。

> 曾考虑过用 Wilson 上界（`<43.5%`）表示小样本的不确定性，但它需要统计推断、
> 且极端样本会饱和到 100% 而失去信息量。原始分数更简单也更诚实，故改为此方案。

> 这套策略**只改 client 半**，`failureRate` 的投影契约没变，所以**不需要 bump `stateVersion`**。

---

## 三、Client 半：`useProjection` 是怎么来的

这是整条链路里最难查、也最容易卡住的一环。`useProjection` **不是** import 来的，
它是 renderer 动态合成后通过 props 发给组件的：

```
dsh-client-ui-session/lib/client.js:127
  keyedHooks: { projection: (key) => binding.session.projections.faceOf(key) }

dsh-client-ui-renderer/lib/client.js:648-654
  每个声明的 hook 源 → standardHookPropName(name) 变成 prop
  （"projection" → "useProjection"）

dsh-client-ui-renderer/lib/client.js:703-746, 763-769
  standardKit() 把 standard 摊进 kit，ContextualEntry 渲染时 {...kit} 传给组件
```

**关键前提：只有注册进 `scope: "session"` 的 slot，组件才会拿到 `useProjection`。**
`conversation.input.dock` 声明为 `{ kind: 'list', scope: 'session' }`
（`dsh-client-ui-conversation/lib/client.js:18167-18170`），所以可用。
官方 goal dock 就是这么用的（`dsh-client-ui-goal/lib/client.js:372-373`）。

组件收到的相关 props：

```js
function Card({ useProjection, t }) {
  const insight = useProjection('sessionInsight');  // 第二参可选 selector
}
```

`t` 只在注册时声明了 `locale` 才会注入；本插件声明了 `locale: 'sessionInsight'`
并通过 `ctx.locale.register(ns, { zh, en })` 提供字典（字典是**扁平**的 `{ key: string }`）。

### 一条安全约束

**client 半只 `require('react')`。** 官方明确禁止第三方 UI 插件 import
任何 `@deepseek-ai/dsh-client-ui-*`（首方自己可以，goal 就 require 了 primitives）——
因为一个抛错的组件会让**整块 slot entry 崩掉**（`slot entry crashed in '<slot>'`）。
本插件的 `InsightCard` 在 `useProjection` 不可用时返回 `null` 而不是抛错，
就是为了让 slot 作用域万一变化时**降级为不显示**，而不是拖垮整个 slot。

---

## 四、验证结果

不是"应该能跑"，是实际跑过的：

| 验证 | 方法 | 结果 |
|---|---|---|
| **端到端（真实运行中）** | 从正在运行的 Web 服务请求 `/plugins/??dsh-session-insight/client.js&rev=<算出的 rev>` | **200 + 真实 bundle** |
| **界面渲染（真实运行中）** | 用户在 desktop profile 的 GUI 里实际看到状态条 | ✅ 「留意 步数 150 工具 176 失败 16 重复 2 失败率 9%」 |
| Host fold 逻辑 | 真实 zod 4.6.5 跑 11 组事件序列，每步校验 `stateSchema` + `viewSchema` | **24 项断言通过** |
| 引用闸门契约 | 断言内部状态变化时 `state.view` 引用**不变**、可见变化时**变** | 通过 |
| Client 半 + 失败率格式 | 打桩 `window.__ModuleLoader__` + `require`，真实执行 client.js 并渲染；`formatRate` 按渲染输出断言（含真实数字、分数/百分比切换、阈值 10 边界、零调用） | **42 项断言通过** |
| 模块加载 | 从插件目录 `import('./index.js')`，真实解析 zod | 通过 |
| `unwrapExports` 陷阱 | 复现 `cordis-plugin-loader` 的折叠逻辑 | `inject` **未丢**，无 `export default` |
| 目录 vs 文件 specifier | 实测 `import()` 目录失败、文件成功，并模拟 `nearestPackage` 发现链 | 目录 **FAIL**、文件 **OK** |
| 真实加载器 | Desktop CLI `--dump-config`（改动前后回归对比） | 两者都 exit=0、零错误 |
| 对齐宽度 | 代入官方 token 化简，与 `TodoPanel` 的有效宽度逐字比对 | 一致：`min(100% - 64px, 920px)` |

> ⚠️ 注意 `--dump-config` 那行：它**通过不代表插件能用**。目录 specifier 的错误版本同样 exit=0、
> 零报错，但浏览器半永远拿不到。真正的判据是上面第一行（bundle 200）与第二行（界面可见）。

复现验证（下面这些脚本在作者的开发工作区里，**不在本仓库内**，路径按需替换）：

```powershell
node <开发工作区>\_verify_insight\test.mjs
node <开发工作区>\_verify_insight\test-client.mjs
node <开发工作区>\_probe_bundle.mjs      # 对运行中的 host 探测 bundle
node <开发工作区>\_probe_discovery.mjs   # 模拟 host 的 client 发现链
```

---

## 五、怎么装上跑起来

### 装进 desktop profile（本机实际采用的方式）

desktop profile 由 Electron 独占，`dsh plugin` 会直接拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

所以只能直接改 patch 文件。用附带脚本（幂等，可重复跑）：

```powershell
pwsh -File F:\WorkSpace\Coding\DSH_plug\demo01\dsh-session-insight\install.ps1
# 卸载：
pwsh -File F:\WorkSpace\Coding\DSH_plug\demo01\dsh-session-insight\install.ps1 -Uninstall
```

它会往 `C:\Users\Elaina\.dsh\profiles\desktop\cordis.patch.yml` 追加：

```yaml
- insert:
    - id: session-insight
      name: 'file:///F:/WorkSpace/Coding/DSH_plug/demo01/dsh-session-insight/index.js'
```

### ⚠️ 指向文件，不要指向目录

`name:` **必须指向入口文件 `index.js`**。写成包目录会静默失败，且症状极具误导性：

```
file:///.../dsh-session-insight          ← ❌ 目录
  → Node ESM: ERR_UNSUPPORTED_DIR_IMPORT
  → host 半没有 fiber
  → dsh-client-modules 只扫描「拥有 fiber 的 Loader 行」(lib/index.js:836)
  → 浏览器半永不被发现 → /plugins/<id>/client.js 返回 404
  → 界面上什么都不显示，但配置校验（--dump-config）完全通过
```

改成 `file:///.../dsh-session-insight/index.js` 后，`locatePkgJson` 的路径分支
（`lib/index.js:748-770`）会用 `nearestPackage` 从文件所在目录向上找到 `package.json`，
读出 `dsh.client` 与 `exports["./client"]`，浏览器半才被服务。

> 注：`~/.dsh/desktop-overlay/cordis.yml` 里官方那个覆盖层插件指向的也是**文件**（`index.mjs`），
> 这是同一个道理。

### 其它装法（开发靶场）

```powershell
$dsh = "D:\Downloads\software\DSH\resources\runtime\cli\bin\dsh.cmd"   # 必须绝对路径

# 一次性覆盖层，不落盘
& $dsh --profile web --patch "F:\WorkSpace\Coding\DSH_plug\demo01\_overlay-insight.yml"
```

> ⚠️ **做插件操作前要完全退出 Electron 应用。**

### 重启后确认真的加载了

不看界面也能验证 —— 直接问正在运行的 Web 服务要 bundle：

```powershell
node F:\WorkSpace\Coding\DSH_plug\demo01\_probe_bundle.mjs
```

它按 host 的算法（`sha1` over 文件 stat）算出 `rev` 并请求
`/plugins/??<id>/client.js&rev=<rev>`，返回 **200** 才算加载成功。
（脚本里带一个确定已加载的对照包 `dsh-plugin`：它 200 而你的 404，说明 URL 格式对、插件没加载。）

### 关于 `node_modules/zod`

本目录里**预置了一份 zod 4.6.5**（从 Desktop 运行时 asar 内提取），
这样本地路径插件开箱即可解析 `import { z } from 'zod'`，不需要联网安装。
正式发布时应删掉它，让 `dependencies` 里的 `zod: ^4.4.3` 由包管理器安装。

---

## 六、踩坑记录

| 坑 | 说明 |
|---|---|
| **Loader 行必须指向文件，不能指向目录** | `file:` 目录 → `ERR_UNSUPPORTED_DIR_IMPORT` → host 半无 fiber → client 半不被扫描 → 404 且**无任何报错**。详见第五节 |
| **dock 里的条目要自己居中** | `conversation.input.dock` 是整条 composer 栈的**全宽**容器，裸 `div` 会贴左边。必须用 composer token 算宽度 + `margin: 0 auto`，见第八节 |
| 投影 schema 用 zod | `Config` 才是 schemastery。写错的话 `register()` 不报错，直到第一次 `viewSchema.parse` 才炸 |
| `stateVersion` 必须是非负安全整数 | 同 key 跨版本注册会抛 `refusing to share it with stateVersion` |
| `apply` 必须同步且返回同引用 | 异步 view 会返回 Promise，被 `viewSchema.parse` 拒绝；不同引用会让下游每次都重算 |
| `stateSchema` 要包含 `view` 字段 | 从检查点恢复走 `stateSchema.parse(row.val)`（`lib/index.js:297`）。若 `view` 缓存在 state 里却没写进 schema，`.strict()` 会拒绝恢复 |
| `useProjection` 只在 session 作用域 slot 可用 | root 作用域 slot 拿不到它，会静默 `undefined` |
| client 半不能 import `@deepseek-ai/dsh-client-ui-*` | 一个抛错组件会崩掉整块 slot entry |
| 函数插件不能有 `export default` | Loader 的 `unwrapExports` 会折叠模块并**丢掉 `inject`**，且无任何警告 |
| `tool/call` 事件不带工具名 | 必须从 `assistant/message` 的 tool-call 块按 `callId` 配对 |

---

## 七、对齐：让条目和输入框一样宽

`conversation.input.dock` 渲染在 `composerStack` 里（`dsh-client-ui-conversation/lib/client.js:16309`），
而 `composerStack` 的 CSS 只有 `flex-direction: column`（`.Dc7zOa_composerStack`）——
**它是全宽的**。所以一个只设了 `padding` 的 `div` 会贴在左边，而不是对齐输入框。

官方同 slot 的 todo 面板（`TodoPanel` root，`.aSus8q_root`）是靠三件事对齐的：

```css
box-sizing: border-box;
flex: none;
width: calc(100% - 2×var(--dsh-composer-side-clearance) - 4×var(--dsh-composer-dock-inset));
max-width: calc(var(--dsh-composer-card-max-width) - 4×var(--dsh-composer-dock-inset));
margin: 0 auto;   /* ← 居中 */
```

代入本机实际值（全部在官方 CSS 里有定义）：

| 变量 | 值 |
|---|---|
| `--dsh-chat-content-width` | `min(100% - 32px, 920px)` |
| `--dsh-composer-card-max-width` | `calc(chat-content-width + 32px)` = `min(100%, 952px)` |
| `--dsh-composer-side-clearance` | `16px` |
| `--dsh-composer-dock-inset` | `8px` |

化简后：`width = 100% - 64px`，`max-width = min(100% - 32px, 920px)`
→ 有效宽度 `min(100% - 64px, 920px)`，与官方 todo 面板**逐字一致**。

> 这些 token 由 composer 作用域提供，**不要硬编码 px** —— 否则窗口变窄或用户改缩放时又会错位。

---

## 八、下一步可以做什么

- **加一个 `invariant` companion**：`exports["./invariant"]` 可以挂一个校验本包持久化关系的独立插件
  （见 `dsh-tool-todo/lib/invariant.js`）。这是报告里确认的**另一片空白**。
- **把卡片做成投影驱动的更细视图**：比如按工具名展开失败排行 —— 状态里已经记了 `pending[callId].name`，
  只需扩展 `errorByTool` 与 `viewSchema`，记得 **bump `stateVersion`**（改语义必须 bump）。
- **加 `ctx.storageDomain` 持久化**：目前只有进程内状态；跨会话的失败率趋势需要落盘。
