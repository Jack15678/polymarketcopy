<div align="center">

# Polymarket 跟单交易机器人

### *「CTRL+C，CTRL+跟单」*

**在自己的账户中镜像目标交易者在 Polymarket 上的操作** — TypeScript/Node，基于轮询，带仓位上限与安全护栏。

<br/>

*组合、业绩与历史 — 正是本机器人监控并镜像的那类活动。*

<br/>

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

---

## 概览

| | |
|:--|:--|
| **监控** | Polymarket 上的目标用户（地址或用户名 → 代理地址） |
| **轮询** | 按你的节奏（`COPY_POLL_INTERVAL_MS`） |
| **跟单** | 用*你的*钱包下近似订单，支持倍数与单笔上限 |

如果你在找 **polymarket bot**、**polymarket copy trading**、**polymarket trading bot typescript** 或 **clob client bot** — 就是本仓库。

---

## 背景说明

在 **Polymarket** 应用里你会看到 **Activity**（近期成交与领取）— 即机器人轮询的数据流 — 以及 **Positions**（成交后在组合里如何体现），还有组合统计。机器人自动化「跟大户」这一步，省得你手动盯每一笔成交。

---

## 能做什么

- **监控** Polymarket 上的目标用户（地址或用户名 → 代理地址）
- **定期轮询**并拉取近期活动
- **跟单到你的账户**，可选风控（倍数、单笔上限、仅跟成交模式）

---

## 不能做什么

- **不保证盈利**。若目标交易者「跳崖」，机器人只会礼貌地问你要不要一起。
- **不是「印钞套利机」。** 这是跟单。（若要做真套利，通常还要路由、定价与延迟等额外工作。）

---

## 克隆与运行（分步）

### 1. 前置条件

| 要求 | 说明 |
| --- | --- |
| **Git** | 用于克隆仓库（若需要可 [安装 Git](https://git-scm.com/downloads)）。 |
| **Node.js** | **v20 及以上** — 用 `node -v` 检查。若未安装可从 [nodejs.org](https://nodejs.org/) 下载。 |
| **npm** | 随 Node 附带；用 `npm -v` 确认。 |
| **Polymarket 账户** | 由你本人控制且已入金的账户。 |
| **密钥** | 你的 **EOA 私钥** 与从 Polymarket 界面获取的 **代理 / funder 地址**（切勿泄露）。 |

### 2. 克隆仓库

在电脑上选一个父目录，在该处打开终端后执行：

**HTTPS（通用，无需配置 SSH）：**

```bash
git clone https://github.com/SXai-lab/prediction-market-copytrade.git
cd prediction-market-copytrade
```

**SSH（若你对 GitHub 使用 SSH 密钥）：**

项目根目录应能看到 `package.json`、`src/` 和 `.env.example`。

### 3. 安装依赖

在项目根目录（`polymarket-copytrade/`）下：

```bash
npm install
```

这会安装 `package.json` 中列出的依赖（含 `npm run dev` 使用的开发工具）。

### 4. 创建环境文件

机器人从项目根目录的 **`.env`** 读取配置。请从模板复制：

**Windows（命令提示符或 PowerShell）：**

```bash
copy .env.example .env
```

**macOS / Linux：**

```bash
cp .env.example .env
```

### 5. 编辑 `.env`

用编辑器打开 `.env`，至少配置：

- **`COPY_TARGET_USER`** — 要镜像的交易者的 Polymarket 代理地址（`0x…`）或用户名。
- **`POLYMARKET_PRIVATE_KEY`** — 你的钱包私钥（64 位十六进制，可带或不带 `0x`）。
- **`POLYMARKET_ADDRESS`** — 从 Polymarket 界面获取的 **代理 / funder 地址**（不一定与裸 EOA 地址相同）。

可选变量（轮询间隔、倍数、上限等）见下文 [配置](#配置) 与 `.env.example`。

**安全：** 切勿提交 `.env`，也不要在 issue 或聊天中粘贴密钥。`.gitignore` 应把 `.env` 留在本地；若 fork 仓库，推送前请再确认。

### 6. 运行机器人

**开发模式**（TypeScript + watch，常用本地流程）：

```bash
npm run dev
```

**类生产**（先 `npm run build` 编译，再 `node dist/index.js`）：

```bash
npm start
```

运行时保持终端开启。用 **Ctrl+C** 停止。

### 7. 快速自检

- 若进程立刻退出，请看报错：缺 `POLYMARKET_PRIVATE_KEY`、十六进制无效、或无法解析 `COPY_TARGET_USER` 是常见原因（见下文 **故障排除**）。
- 首次测试建议使用 **较小** 的 `COPY_SIZE_MULTIPLIER` 与 **非零** 的 `COPY_MAX_ORDER_USD` 上限（见下文 **安全**）。

---

## 速查

| 步骤 | 命令 |
| --- | --- |
| git clone | https://github.com/SXai-lab/prediction-market-copytrade |
| 进入目录 | `cd prediction-market-copytrade` |
| 安装 | `npm install` |
| 环境文件 | Windows：`copy .env.example .env`；macOS/Linux：`cp .env.example .env` |
| 运行（开发） | `npm run dev` |
| 运行（启动） | `npm start` |

---

## 配置

所有配置通过环境变量完成（见 `.env.example`）。

### 跟单目标

任选其一：

- **`COPY_TARGET_USER`**：目标代理地址 *或* 用户名（机器人会尝试将用户名解析为代理）

### 核心参数

| 变量 | 作用 | 示例 |
|---|---|---|
| `COPY_POLL_INTERVAL_MS` | 多久轮询一次新活动 | `15000` |
| `COPY_ACTIVITY_LIMIT` | 每次轮询考虑多少条近期活动 | `100` |
| `COPY_SIZE_MULTIPLIER` | 跟单规模的倍数 | `1` |
| `COPY_MAX_ORDER_USD` | 每笔跟单硬上限（0 表示不设上限） | `25` |
| `COPY_TRADES_ONLY` | 若为 `true`，不跟非成交类活动 | `true` |

### 你的钱包 / Polymarket 账户

| 变量 | 必填 | 说明 |
|---|---:|---|
| `POLYMARKET_PRIVATE_KEY` | ✅ | 64 位十六进制（可带或不带 `0x`） |
| `POLYMARKET_ADDRESS` | ✅ | 你在界面上的 Polymarket 代理/funder 地址 |
| `POLYMARKET_SIGNATURE_TYPE` | ❌ | 通常自动检测；仅在需要时覆盖 |
| `POLYMARKET_CHAIN_ID` | ❌ | 多数环境默认为 Polygon |

---

## 安全 / 「凌晨三点别私信我」

- **永远不要提交 `.env`**。一旦泄露，全网都会把它当免费样品。
- 测试时可考虑用 **新钱包** 且 **限额资金**。
- 可从 `COPY_SIZE_MULTIPLIER=0.1` 与较小的 `COPY_MAX_ORDER_USD` 起步。

---

## 故障排除

- **`POLYMARKET_PRIVATE_KEY is required...`**  
  私钥缺失或不是合法十六进制。机器人接受 **64 位十六进制**，可选前缀 `0x`。

- **"Could not resolve username to proxy"**  
  对 `COPY_TARGET_USER` 使用 **代理地址**（0x…），或核对目标是否正确。

---

## 常见问题

### 这是「套利」吗？

它可以作为套利流程的一环，但单独使用时主要是 **跟单**。若要做真套利，多半还要市场扫描、价差逻辑与执行路由。

### 快吗？

采用 **轮询**（`COPY_POLL_INTERVAL_MS`）。若要低延迟镜像，需要流式方案。

---

## 贡献

文档整理：2026 年一季度。

欢迎 PR。若新增功能，请一并提供：

- 合理的默认值
- 安全护栏（限制优于梭哈）
- 在本 README 中的简短说明

---

## 免责声明

本软件仅供学习研究。你怎么用它由你自负责任。交易有风险，包括某天发现自己其实并不是主角的风险。
