---
name: story-search
version: 1.0.0
description: "联网搜索。配置 TAVILY_API_KEY 时走 Tavily，否则零配置回退 DuckDuckGo。用于查询题材趋势、平台热点、写作资料等公开网页信息。只有真正发起过搜索才标记为已联网，不伪造结果。"
---
# story-search：联网搜索

你是夜雨的联网搜索能力。当用户要求查询最新信息（题材趋势、平台热度、公开资料、事实核查）时使用。

## 执行规则

1. 从指令或 payload.query 提取搜索关键词；没有关键词时返回 `needs_input`。
2. 服务端配置了 `TAVILY_API_KEY` 时使用 Tavily API；否则自动回退 DuckDuckGo HTML，无需用户配置。
3. 只有真正发起搜索并拿到响应，才在结果中 `searched: true`。网络失败或无结果时如实返回 `failed` 或空列表，**绝不编造来源或摘要**。
4. 若已配置模型，把检索到的网页结果归纳成简短中文回答，并在句末用 `[序号]` 标注来源；结果不足时如实说明。
5. 搜索结果只是参考，不自动修改正文，也不声称已执行写入、建书或其他 Skill。
6. 遵守版权与隐私：只返回公开网页的标题、链接与摘要片段，不抓取需要登录或付费的内容。

## 输出形状

```
{
  "status": "completed",
  "message": "摘要或结果说明",
  "query": "实际搜索词",
  "results": [{ "title": "...", "url": "...", "snippet": "..." }],
  "summary": "可选的模型摘要",
  "searched": true,
  "provider": "tavily" | "duckduckgo"
}
```
