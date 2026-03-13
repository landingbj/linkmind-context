# LinkMind Context Engine Plugin for OpenClaw

一个基于 OpenClaw 官方 `ContextEngine` 接口规范实现的上下文压缩引擎插件，通过调用 LinkMind API 对对话历史进行智能压缩，在保留关键信息的前提下控制上下文增长。

---

## 项目结构

```
linkmind-context/
├── src/
│   ├── index.ts               # 插件主逻辑
│   └── types.ts               # ContextEngine 接口类型定义
├── dist/                      # 构建产物（npm run build 生成）
├── openclaw.plugin.json       # OpenClaw 插件清单
├── package.json
├── tsconfig.json
└── README.md
```

LinkMind Java 服务端（独立项目）新增的文件：

```
lagi-web/src/main/java/
├── ai/dto/linkmind/
│   ├── CompressMessage.java   # 单条消息数据结构
│   ├── CompressRequest.java   # 压缩接口请求体
│   └── CompressResponse.java  # 压缩接口响应体
└── ai/servlet/api/
    └── LinkMindApiServlet.java  # POST /v1/linkmind/compress 接口实现
```

---

## 安装步骤

### 1. 安装依赖 & 构建

```bash
cd linkmind-context
npm install
npm run build
```

### 2. 安装插件到 OpenClaw

在插件根目录执行（每次修改代码后需重新执行）：

```bash
# 如果已安装过旧版本，先删除再重装：
rm -rf %USERPROFILE%\.openclaw\extensions\linkmind-context
openclaw plugins install .
```

安装成功后会看到：

```
Installed plugin: linkmind-context
Restart the gateway to load plugins.
```

### 3. 配置 openclaw.json

打开 `%USERPROFILE%\.openclaw\openclaw.json`，添加以下配置：

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "linkmind-context"
    },
    "entries": {
      "linkmind-context": {
        "config": {
          "debug": true,
          "compressionThreshold": 50,
          "apiUrl": "http://localhost:8080/v1"
        }
      }
    }
  }
}
```

**字段说明：**

| 字段 | 说明 |
|------|------|
| `plugins.slots.contextEngine` | 指定激活哪个 Context Engine，必须填插件 id，否则 OpenClaw 会回退到内置引擎 |
| `plugins.entries.<id>.config` | 传给插件的配置，对应 `LinkMindPluginConfig` |

### 4. 启动 LinkMind Java 服务

确保 LinkMind 服务已编译并运行，`apiUrl` 中的地址和端口与服务实际监听地址一致。

### 5. 重启 Gateway

在 OpenClaw 界面重启 Gateway，然后**新建会话**（不要复用旧会话，否则引擎实例是旧的）。

> **迭代流程**：每次修改代码 → `npm run build` → `rm 旧目录` → `openclaw plugins install .` → 重启 Gateway → 新建会话

---

## 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `apiUrl` | `string` | `https://api.linkmind.dev/v1` | LinkMind 服务地址，本地开发时改为 `http://localhost:<端口>/v1` |
| `apiKey` | `string` | `''` | LinkMind API 密钥，有鉴权时填写 |
| `compressionThreshold` | `number` | `1000` | 触发压缩的字符数阈值，全部历史消息字符总数超过此值时调用 `compact()`；调试时可设为 `50` 方便触发 |
| `debug` | `boolean` | `false` | 开启后在 Gateway 日志中输出详细的生命周期信息 |

---

## 生命周期说明

每次用户发送一条消息，OpenClaw 都会完整走一遍以下流程：

```
用户发消息
    │
    ▼
bootstrap()     初始化引擎，记录 sessionId 和 session 文件路径
    │
    ▼
assemble()      决定喂给 AI 模型哪些历史消息，返回实际上下文
    │
    ▼
[ AI 模型处理中 ]
    │
    ▼
afterTurn()     回合结束后统计上下文字符总量
    │            如果超过 compressionThreshold，缓存 messages 并调用 compact()
    ├─超阈值──▶ compact()   取出缓存的 messages，调用 LinkMind 压缩接口
    │
    ▼
dispose()       清理资源，等待下一条消息
```

**关于 `ownsCompaction: true`**：插件在 `info` 中声明了 `ownsCompaction: true`，这意味着 OpenClaw 不会自动触发压缩，压缩时机完全由插件在 `afterTurn()` 中自行判断。

**关于 messages 传递**：`compact()` 的接口参数中不包含 messages，因此 `afterTurn()` 在触发压缩前会将 messages 缓存到实例变量 `_pendingMessages`，`compact()` 从中取出后调用 API，调用完成后清空缓存。

---

## 压缩接口（LinkMind Java 服务端）

### 接口地址

```
POST /v1/linkmind/compress
Content-Type: application/json
```

### 请求体字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | OpenClaw 会话唯一 ID，用于区分不同对话窗口 |
| `messages` | `CompressMessage[]` | 完整对话历史数组，待压缩的全部消息 |
| `tokenBudget` | `number` | 模型上下文窗口容量（如 128000），压缩后应控制在此范围内 |
| `currentTokenCount` | `number` | 压缩前的 token 粗估值（总字符数 ÷ 4） |

每条 `CompressMessage` 的字段：

| 字段 | 说明 |
|------|------|
| `role` | 消息角色：`user`、`assistant`、`system`、`toolResult` 等 |
| `content` | 内容块数组，每块有 `type` 和对应内容字段 |

`content` 中 `type` 的常见取值：

| type | 说明 |
|------|------|
| `text` | 普通文本内容 |
| `thinking` | 模型的内部推理过程（扩展思考模式产生，可在压缩时优先丢弃） |
| `toolResult` | 工具调用结果（读文件、搜索等，失败的结果可在压缩时丢弃） |

### 响应体字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `string` | `"success"` 或 `"error"` |
| `messages` | `CompressMessage[]` | 压缩后的消息数组，替换原始历史 |
| `tokensBefore` | `number` | 压缩前 token 数（从请求中透传，方便日志对比） |
| `tokensAfter` | `number` | 压缩后 token 估算值 |
| `error` | `string` | 当 status 为 `"error"` 时的错误描述 |

### 压缩策略建议（待实现）

根据实际观察到的消息结构，以下内容可优先压缩或丢弃：

- `thinking` 类型的内容块：模型推理过程，上下文中不需要保留
- 失败的 `toolResult`（如文件不存在的 ENOENT 错误）：无信息量
- 早期轮次的文件读取结果（如 SOUL.md、USER.md）：内容固定，不必每次携带
- 保留：最近几轮的 `user` + `assistant` 实际对话内容

---

## License

ISC
