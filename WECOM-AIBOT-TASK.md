# 任务：WeCom 智能机器人（AI Bot）回调支持

## 背景

企业微信有两种机器人：「自建应用」和「智能机器人」。当前 WeCom 插件只支持自建应用（XML回调），需要新增智能机器人支持（JSON回调）。两者共用同一个 webhook 端口和路径。

## 代码位置

- WeCom 插件：`extensions/wecom/src/`
- 关键文件：`bot.ts`、`monitor.ts`、`send.ts`、`outbound.ts`、`channel.ts`

## 当前配置（已在 openclaw.json 中）

```json
"bot": {
  "token": "DljsUY0K9DVvWNjQf8g1fTDxjJU",
  "encodingAesKey": "XhhnoyF0mLMqaSPN1K21MYytQRS9jnYl8ewJsYVFpTP",
  "webhookPort": 9002,
  "botId": "aibILF6zQjtXyu-M4nBqdg7ECtY7QiiuOBE"
}
```

绑定：`bot` account → `xichang` agent

## 核心区别：智能机器人 vs 自建应用

### 回调验证（GET请求）

**相同**。都是 `msg_signature + timestamp + nonce + echostr` 验签解密。现有代码已处理。

### 消息接收（POST请求）

**完全不同！**

|                | 自建应用                                                             | 智能机器人                                                          |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| POST body 格式 | XML: `<xml><ToUserName>...</ToUserName><Encrypt>...</Encrypt></xml>` | JSON: `{"encrypt":"ENCRYPTED_BASE64"}`                              |
| 解密后内容     | XML                                                                  | JSON                                                                |
| 消息字段       | ToUserName, FromUserName, MsgType, Content, AgentID                  | aibotid, from.userid, msgtype, text.content, chattype, response_url |
| 回复方式       | 被动回复XML / 主动调API                                              | 被动回复加密JSON（支持流式） / POST到response_url                   |

### 解密后的消息格式（智能机器人）

```json
{
  "msgid": "MSGID",
  "aibotid": "AIBOTID",
  "chatid": "CHATID",
  "chattype": "single|group",
  "from": { "userid": "USERID" },
  "response_url": "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=XXX",
  "msgtype": "text|image|voice|file|mixed|streaming",
  "text": { "content": "消息内容" }
}
```

### 流式消息刷新事件

企微持续 POST 刷新事件，解密后格式：

```json
{
  "msgid": "MSGID",
  "aibotid": "AIBOTID",
  "chattype": "single|group",
  "from": { "userid": "USERID" },
  "response_url": "RESPONSEURL",
  "msgtype": "streaming",
  "streaming": { "id": "STREAMID" }
}
```

## 回复方式

### 方式1：被动回复（流式，推荐）

在 HTTP response body 中返回加密的 JSON。

**首次回复**（收到用户消息时）：

```json
{
  "msgtype": "stream",
  "stream": {
    "id": "unique-stream-id-xxx",
    "finish": false,
    "content": "部分回复内容"
  }
}
```

**后续回复**（收到 streaming 刷新事件时）：

```json
{
  "msgtype": "stream",
  "stream": {
    "id": "同一个stream-id",
    "finish": false,
    "content": "更长的累积内容（不是增量，是全文）"
  }
}
```

**最后回复**：

```json
{
  "msgtype": "stream",
  "stream": {
    "id": "同一个stream-id",
    "finish": true,
    "content": "完整的最终回复"
  }
}
```

**加密方式**：跟自建应用被动回复一样，用 EncodingAESKey 的 AES-256-CBC 加密，返回格式：

```json
{
  "encrypt": "BASE64_ENCRYPTED",
  "msgsignature": "SIGNATURE",
  "timestamp": "TIMESTAMP",
  "nonce": "NONCE"
}
```

注意：

- content 是**累积式**的（第一次"你"，第二次"你好"，第三次"你好世界"）
- 支持 `<think></think>` 标签展示思考过程
- content 支持 markdown 格式
- 企微从用户发消息开始最多等 6 分钟

### 方式2：主动回复（response_url）

POST 明文 JSON 到 response_url（不需要加密）：

```json
{
  "msgtype": "markdown",
  "markdown": { "content": "回复内容" }
}
```

每个 response_url 只能用一次，有效期 1 小时。

## 实现方案

### Step 1：在 monitor.ts 区分 JSON/XML

当前 POST 处理在 `monitor.ts` 的 HTTP server 中。需要：

1. 尝试解析 POST body 为 JSON
2. 如果是 JSON 且有 `encrypt` 字段 → 智能机器人路径
3. 否则 → 现有自建应用路径（XML）

### Step 2：解密智能机器人消息

1. 从 JSON body 取 `encrypt` 字段
2. 用同样的 AES 解密逻辑（已有，在 crypto 相关代码中）解密
3. 解密后得到 JSON 字符串，parse 为对象
4. 通过 `aibotid` 匹配到对应的 account（config 中的 `botId` 字段）

### Step 3：解析消息并 dispatch

把智能机器人消息转换为 OpenClaw 的标准格式：

- `from.userid` → 发送者
- `text.content` → 消息内容
- `chattype` → single/group
- `chatid` → 群聊ID
- `response_url` → 保存下来用于回复
- `msgtype=streaming` → 流式刷新事件，不是新消息

### Step 4：回复

**推荐用流式被动回复**：

1. agent dispatch 后获取回复文本
2. 加密回复 JSON
3. 在 HTTP response 中返回

如果 agent 还没出结果但需要先返回 HTTP response，可以：

- 先返回流式开始（finish=false, content="思考中..."）
- 后续通过 streaming 刷新事件返回真正内容

如果流式太复杂，**先用 response_url 方式**作为 MVP：

1. HTTP response 返回空（或返回流式开始）
2. agent 完成后 POST 到 response_url

### Step 5：加密被动回复

被动回复需要加密。加密流程：

1. 生成随机 16 字节 nonce
2. 将回复 JSON 字符串用 AES-256-CBC 加密（key 从 EncodingAESKey base64 解码，IV 为 key 前 16 字节，PKCS#7 填充）
3. 加密前拼接：随机16字节 + 消息长度(4字节大端) + 消息内容 + botId
4. 计算 msg_signature = SHA1(sort([token, timestamp, nonce, encrypt]))
5. 返回 `{"encrypt":"...", "msgsignature":"...", "timestamp":"...", "nonce":"..."}`

## DO NOT TOUCH

- 自建应用的现有 XML 回调处理逻辑（不要改坏）
- `send.ts` 中的 `sendWeComVoice` 函数
- `outbound.ts` 中的音频处理逻辑
- `src/agents/subagent-monitor.ts`
- `src/agents/subagent-registry.ts`
- 任何非 `extensions/wecom/src/` 目录的源码（除非绝对必要）

## 参考文档

- 智能机器人概述：https://developer.work.weixin.qq.com/document/path/101039
- 接收消息：https://developer.work.weixin.qq.com/document/path/100719
- 被动回复消息：https://developer.work.weixin.qq.com/document/path/101031
- 主动回复（response_url）：https://developer.work.weixin.qq.com/document/path/101138
- 加解密方案：https://developer.work.weixin.qq.com/document/path/100721（需登录查看）
- 官方 Python 示例：https://dldir1.qq.com/wework/wwopen/file/aibot_demo_python.tar.gz

## 完成标准

1. `pnpm build` 通过
2. 智能机器人发消息能收到并 dispatch 到 xichang agent
3. agent 回复能通过流式被动回复或 response_url 发回给用户
4. 自建应用的现有功能不受影响
5. git commit
