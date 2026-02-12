# OpenClaw Agent 开发准则

## 核心原则：先读后写，逐步验证

---

## 1. 永远先读现有代码再动手

**禁止凭记忆猜测接口签名。** 写任何代码之前，必须：

- **读类型定义**：用 grep/glob 找到你要实现的接口（如 `ChannelOutboundAdapter`、`ReplyDispatcher`），读它的完整类型声明，确认每个字段和方法名。
- **读同级实现**：如果你要写 `extensions/wecom/src/outbound.ts`，先读 `extensions/feishu/src/outbound.ts` 和 `extensions/discord/src/outbound.ts`，看别人怎么实现的。
- **读调用方**：如果你要实现一个接口，找到框架中调用这个接口的代码，确认它期望的参数和返回值。

**反例**：直接写 `async send({ cfg, to, text })` 而实际接口要求的是 `sendText` 和 `sendMedia`。
**正例**：先 `grep "ChannelOutboundAdapter" src/` 找到类型定义，确认方法名是 `sendText`/`sendMedia`，再写代码。

## 2. 每写完一个文件立刻编译

不要写完所有文件才 build。每写完或改完一个文件：

```bash
pnpm build
```

- 编译通过 → 继续下一个文件
- 编译失败 → 立刻修复，不要累积错误

这能在第一时间发现类型不匹配、接口签名错误、缺少导入等问题。

## 3. 严格遵循现有模式

- **文件结构**：看同类插件的目录结构（如 `extensions/feishu/`），按相同模式组织文件。
- **命名风格**：如果现有代码用 `PascalCase` 键名（`Body`、`SessionKey`、`ChatType`），不要自作主张用 `camelCase`（`body`、`sessionKey`、`chatType`）。
- **调用模式**：如果 Feishu 用 `core.channel.reply.createReplyDispatcherWithTyping()` 创建 dispatcher，你也用同样的方式，不要自己发明一个 dispatcher 对象。

## 4. 不要修改不属于你任务范围的文件

- 如果任务是"写 wecom 插件代码"，**不要动** `openclaw.json`、`pnpm-lock.yaml`、其他插件的代码。
- 如果确实需要改配置文件，先说明要改什么、为什么要改，等确认后再改。
- 特别注意：不要破坏已有的、正在工作的配置。

## 5. 处理外部 API 时考虑运行环境

- **网络限制**：某些 API（如企业微信）有 IP 白名单，本地直连可能被拒绝，可能需要通过代理转发。
- **密钥管理**：不要把 token/secret 硬编码，从配置中读取。
- **错误处理**：API 调用失败时要有日志输出，不要静默吞掉错误。

## 6. 任务拆分与自检清单

拿到一个大任务时，先拆分成小步骤，每步完成后自检：

```
□ 读完了目标接口的类型定义
□ 读完了至少一个同类实现作为参考
□ 写完代码后 pnpm build 编译通过
□ 没有修改任务范围外的文件
□ 没有引入未使用的 import
□ 接口方法名和参数名与类型定义完全一致
```

## 7. 遇到不确定的地方

- **不要猜**。去读源码确认。
- 如果读了源码还不确定，**问用户**而不是按猜测继续写。
- 一个错误的实现比没有实现更糟糕——它会浪费更多时间来调试和修复。
