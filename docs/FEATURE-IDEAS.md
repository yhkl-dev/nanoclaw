# NanoClaw 功能扩展建议

> 记录可以集成到 Ollama 工具链的功能点，按优先级和复杂度排列。

---

## 已完成 ✅

| 功能 | 说明 |
|------|------|
| Gmail 工具 | `gmail_list` / `gmail_read` / `gmail_search` / `gmail_send` |
| Google Calendar 工具 | `calendar_list` / `calendar_create` / `calendar_delete` |
| Tavily 搜索 | `tavily_search` — AI 优化的网页搜索 |
| 系统监控 | `system_stats` — CPU / 内存 / 磁盘 / 温度 / 负载 |
| GitHub 通知 | `github_notifications` / `github_search` |
| Bark 推送 | `bark_push` — 发送 iPhone 推送通知 |
| 每日早报 | 08:00 CST 定时推送 Gmail + 日历 + 沈阳天气 |

---

## 建议功能

### 🏠 本地 / 家庭自动化

#### Home Assistant 集成
- **工具**: `ha_state`（查设备状态）、`ha_service`（控制设备）、`ha_history`（历史数据）
- **接入**: 只需 HA 地址 + Long-Lived Token，加到 `.env`
- **示例**:
  - "客厅灯关了吗？"
  - "把卧室空调设成 26 度"
  - "今天家里用了多少电？"
- **难度**: 低
- **配置**: `HA_URL` + `HA_TOKEN` in `.env`

#### Docker 管理
- **工具**: `docker_ps`（列容器）、`docker_logs`（查日志）、`docker_restart`（重启）
- **接入**: 调用 Docker socket，无需额外配置（前提是进程有权限）
- **示例**:
  - "nanoclaw 容器现在跑着吗？"
  - "帮我看看 nginx 最近 50 行日志"
- **难度**: 低
- **配置**: 无需

#### Wake-on-LAN
- **工具**: `wol_wake`（发魔法包唤醒电脑）
- **接入**: 纯本地，发 UDP 广播包
- **示例**: "帮我开一下工作电脑"
- **难度**: 很低
- **配置**: MAC 地址列表 in `.env` 或 groups/main/CLAUDE.md

---

### 📝 笔记 / 知识管理

#### Notion 集成
- **工具**: `notion_query`（查数据库）、`notion_create`（新建页面/条目）
- **接入**: Notion Integration Token + Database ID
- **示例**:
  - "把这个方案保存到 Notion 的项目记录里"
  - "查一下我上周记的会议笔记"
- **难度**: 中
- **配置**: `NOTION_TOKEN` + `NOTION_DB_ID` in `.env`

#### 本地文件搜索
- **工具**: `file_search`（在指定目录全文检索）
- **接入**: 用 ripgrep / find，已有 `bash_exec` 可覆盖部分需求
- **示例**: "帮我找 ~/Documents 里提到「合同」的文件"
- **难度**: 很低（已有 bash_exec，封装一下即可）

---

### 📊 信息聚合

#### RSS 订阅聚合
- **工具**: `rss_fetch`（拉取指定 Feed 的最新条目）
- **内置 Feed 推荐**:
  - `https://hnrss.org/frontpage` — Hacker News
  - `https://36kr.com/feed` — 36氪
  - `https://sspai.com/feed` — 少数派
  - `https://www.v2ex.com/index.xml` — V2EX
- **集成到早报**: 在每日 08:00 早报里追加"今日热文"板块
- **难度**: 低（纯 HTTP + XML 解析）
- **配置**: Feed URL 列表 in `.env` 或 CLAUDE.md

#### 汇率 / 股票行情
- **工具**: `exchange_rate`（实时汇率）、`stock_quote`（A股/港股/美股）
- **免费 API**:
  - 汇率: `https://api.exchangerate-api.com/v4/latest/CNY`（免费）
  - A股: `https://hq.sinajs.cn/list=sh000001`（新浪接口，免费）
- **示例**:
  - "现在美元兑人民币多少？"
  - "茅台今天涨了吗？"
- **难度**: 低
- **配置**: 无需（免费接口）

#### 快递查询
- **工具**: `express_track`（输入单号查物流）
- **接入**: 快递100 或 快递鸟 API（免费额度够用）
- **示例**: "顺丰 SF1234567890 现在到哪了？"
- **难度**: 低
- **配置**: `KUAIDI100_KEY` in `.env`

---

### 🤖 Ollama 能力增强

#### 多模型路由
- **思路**: 在 `ollama-direct.ts` 里根据问题复杂度自动选模型
  - 简单问答 / 闲聊 → `qwen2.5:7b`（秒回）
  - 代码 / 推理 → `qwen3.5:35b`（当前主力）
  - 图片描述 → `llava:13b`（vision 模型）
- **判断方式**: token 预估长度、是否含代码/图片、是否需要工具调用
- **难度**: 中
- **收益**: 简单问题响应从 10s → 1s

#### 图片识别 (Vision)
- **工具**: 企业微信图片消息自动转发给 vision 模型分析
- **接入**: WeCom 已能收图片消息，需要：
  1. 下载图片到本地
  2. Base64 编码
  3. 发给支持 vision 的 Ollama 模型（`llava` / `minicpm-v`）
- **示例**: 发截图给 Henry，他描述图里的内容
- **难度**: 中
- **配置**: 需要拉取 `ollama pull llava:13b`

#### 对话中切换模型
- **工具**: `switch_model`（临时换模型处理这条消息）
- **示例**: "用小模型快速翻译一下这段文字"
- **难度**: 低

---

### 📱 通知 / 提醒增强

#### 企业微信日历集成
- **说明**: 直接读写企业微信日程，不依赖 Google Calendar
- **接入**: 需要企业微信自建应用的 `AgentID` + `Secret`（企业管理员后台申请）
- **API**: `https://qyapi.weixin.qq.com/cgi-bin/oa/get_schedule_list`
- **示例**:
  - "我明天有什么日程？"
  - "帮我加一个明天下午3点的会议"
- **难度**: 中（需要管理员权限）
- **配置**: `WECOM_CORP_ID` + `WECOM_OA_AGENT_ID` + `WECOM_OA_SECRET`

#### PushDeer / Gotify 推送备选
- **说明**: Bark 的替代方案
  - **PushDeer**: 开源自部署，也支持 iOS
  - **Gotify**: 自部署推送服务器，Android/桌面友好
- **难度**: 很低（都是简单 HTTP POST）

---

## 优先级推荐

如果只挑 3 个做：

1. **RSS 聚合** — 直接增强每日早报，无需配置，实现简单
2. **汇率/股票** — 日常高频查询，免费接口，无依赖
3. **Home Assistant** — 如果家里有智能设备，体验提升最大

---

*最后更新: 2026-04-02*
