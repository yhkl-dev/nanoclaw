import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { OLLAMA_FAST_MODEL, OLLAMA_HOST, OLLAMA_MODEL } from '../config.js';
import { logger } from '../logger.js';
import type {
  Intent,
  IntentResult,
  LLMClassifierConfig,
  ClassifierStats,
} from './types.js';

const CACHE_DIR = path.join(process.cwd(), '.cache/intent-cache');
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLASSIFY_TIMEOUT_MS = 30_000;

export class LLMIntentClassifier {
  private config: LLMClassifierConfig;
  private stats: ClassifierStats;

  constructor(config: LLMClassifierConfig) {
    this.config = config;
    this.stats = {
      totalRequests: 0,
      cachedRequests: 0,
      llmRequests: 0,
      averageLatencyMs: 0,
      intentsUsed: new Map(),
    };
  }

  async classify(userMessage: string): Promise<IntentResult> {
    const startTime = Date.now();
    this.stats.totalRequests++;

    const preview =
      userMessage.slice(0, 60) + (userMessage.length > 60 ? '…' : '');
    logger.info(
      { model: this.config.modelId, preview },
      '[intent] classifying message',
    );

    // 检查缓存
    if (this.config.cacheEnabled) {
      const cached = await this.getCachedResult(userMessage);
      if (cached) {
        this.stats.cachedRequests++;
        this.updateIntentStats(cached.intent);
        logger.info(
          {
            intent: cached.intent,
            confidence: cached.confidence,
            source: 'cache',
          },
          '[intent] result (cache hit)',
        );
        return { ...cached, rawPrompt: userMessage };
      }
    }

    // 调用 LLM 进行分类
    this.stats.llmRequests++;
    const result = await this.callLLM(userMessage);

    // 缓存结果
    if (this.config.cacheEnabled) {
      await this.cacheResult(userMessage, result);
    }

    const latency = Date.now() - startTime;
    this.stats.averageLatencyMs =
      (this.stats.averageLatencyMs * (this.stats.totalRequests - 1) + latency) /
      this.stats.totalRequests;
    this.updateIntentStats(result.intent);

    return result;
  }

  private updateIntentStats(intent: Intent): void {
    this.stats.intentsUsed.set(
      intent,
      (this.stats.intentsUsed.get(intent) ?? 0) + 1,
    );
  }

  private async callLLM(userMessage: string): Promise<IntentResult> {
    const host = OLLAMA_HOST;
    // Use OLLAMA_FAST_MODEL if set, otherwise fall back to the main OLLAMA_MODEL.
    // When only one model is loaded in VRAM, reusing it avoids model-swap overhead.
    const model = OLLAMA_FAST_MODEL || OLLAMA_MODEL;

    if (!host || !model) {
      logger.info('[intent] no model configured, using keyword match only');
      return this.fallbackKeywordMatch(userMessage);
    }

    const t0 = Date.now();
    logger.info({ model, host }, '[intent] calling LLM for classification');

    try {
      const systemPrompt = `You are an intent classification assistant. Analyze the user's message and identify the most likely intent.

Return ONLY a JSON object (no markdown, no explanation) with these fields:
- intent: one of: chat, search_web, browse_web, read_file, write_file, run_bash, bash_exec, schedule_task, send_email, read_email, gmail_list, gmail_read, gmail_search, gmail_send, calendar_list, calendar_create, calendar_delete, tavily_search, system_stats, browser_open, unknown
- confidence: float 0.0-1.0
- entities: object with extracted parameters (optional)

Examples:
User: "帮我搜索一下苹果股价" -> {"intent":"tavily_search","confidence":0.9,"entities":{"query":"苹果股价"}}
User: "打开 github.com" -> {"intent":"browser_open","confidence":0.92,"entities":{"url":"https://github.com"}}
User: "你好" -> {"intent":"chat","confidence":0.98}
User: "查看我的邮件" -> {"intent":"gmail_list","confidence":0.9}
User: "系统内存使用率" -> {"intent":"system_stats","confidence":0.95}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);

      let rawText = '';
      try {
        const response = await fetch(`${host}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage },
            ],
            format: 'json',
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        rawText = await response.text();
        if (!response.ok) {
          throw new Error(
            `Ollama ${response.status}: ${rawText.slice(0, 200)}`,
          );
        }
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }

      const parsed = JSON.parse(rawText) as { message?: { content?: string } };
      const content = parsed.message?.content ?? '';
      const latencyMs = Date.now() - t0;

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn(
          { latencyMs, raw: content.slice(0, 200) },
          '[intent] LLM returned no JSON, falling back to keyword match',
        );
        return this.fallbackKeywordMatch(userMessage);
      }

      const result = JSON.parse(jsonMatch[0]) as IntentResult;
      if (!result.intent || typeof result.confidence !== 'number') {
        logger.warn(
          { latencyMs, parsed: result },
          '[intent] LLM result missing fields, falling back to keyword match',
        );
        return this.fallbackKeywordMatch(userMessage);
      }

      result.entities = result.entities ?? {};
      result.rawPrompt = userMessage;

      logger.info(
        {
          intent: result.intent,
          confidence: result.confidence,
          entities: result.entities,
          latencyMs,
          source: 'llm',
        },
        '[intent] result (LLM)',
      );
      return result;
    } catch (error) {
      const latencyMs = Date.now() - t0;
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      logger.warn(
        { err: isTimeout ? 'timeout' : String(error), latencyMs },
        isTimeout
          ? '[intent] LLM timed out, falling back to keyword match'
          : '[intent] LLM error, falling back to keyword match',
      );
      return this.fallbackKeywordMatch(userMessage);
    }
  }

  private fallbackKeywordMatch(message: string): IntentResult {
    const m = message.toLowerCase();

    const rules: [Intent, string[]][] = [
      ['gmail_send', ['发邮件', '发送邮件', '写邮件', 'send email']],
      [
        'gmail_list',
        ['查邮件', '看邮件', '邮件列表', 'list email', 'check email'],
      ],
      ['gmail_search', ['搜邮件', '查找邮件', 'search email']],
      [
        'calendar_create',
        ['创建日程', '新建日历', '添加事件', 'create event', 'add calendar'],
      ],
      [
        'calendar_list',
        ['查日历', '日程安排', '看日历', 'list calendar', 'check calendar'],
      ],
      ['tavily_search', ['搜索', '查询', '查一下', '了解', 'search', 'find']],
      [
        'browse_web',
        ['打开网页', '访问', '浏览', '网址', 'open url', 'browse'],
      ],
      [
        'system_stats',
        [
          '系统状态',
          'cpu',
          '内存',
          '磁盘',
          '负载',
          'system stats',
          'memory usage',
        ],
      ],
      ['run_bash', ['执行命令', '运行', '跑一下', 'run command', 'execute']],
      ['read_file', ['读取文件', '查看文件', '打开文件', 'read file']],
      ['write_file', ['写文件', '写入', '更新文件', 'write file']],
      [
        'schedule_task',
        ['定时', '每天', '每小时', '提醒我', 'schedule', 'remind'],
      ],
    ];

    for (const [intent, keywords] of rules) {
      if (keywords.some((k) => m.includes(k))) {
        logger.info(
          { intent, confidence: 0.65, source: 'keyword' },
          '[intent] result (keyword fallback)',
        );
        return { intent, confidence: 0.65, rawPrompt: message };
      }
    }

    logger.info(
      { intent: 'chat', confidence: 0.5, source: 'default' },
      '[intent] result (default chat)',
    );
    return { intent: 'chat', confidence: 0.5, rawPrompt: message };
  }

  private cacheKey(message: string): string {
    return createHash('md5').update(message).digest('hex');
  }

  private cacheFilePath(message: string): string {
    return path.join(CACHE_DIR, `${this.cacheKey(message)}.json`);
  }

  private async cacheResult(
    message: string,
    result: IntentResult,
  ): Promise<void> {
    try {
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }
      fs.writeFileSync(this.cacheFilePath(message), JSON.stringify(result));
    } catch {
      // non-critical
    }
  }

  private async getCachedResult(message: string): Promise<IntentResult | null> {
    try {
      const file = this.cacheFilePath(message);
      if (!fs.existsSync(file)) return null;

      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (age > (this.config.cacheTtlMs || DEFAULT_CACHE_TTL_MS)) return null;

      return JSON.parse(fs.readFileSync(file, 'utf-8')) as IntentResult;
    } catch {
      return null;
    }
  }

  getStats(): ClassifierStats {
    return { ...this.stats };
  }

  clearCache(): void {
    if (fs.existsSync(CACHE_DIR)) {
      fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    }
  }
}

// Singleton instance
let _classifier: LLMIntentClassifier | null = null;

function getClassifier(): LLMIntentClassifier {
  if (!_classifier) {
    const model = OLLAMA_FAST_MODEL ?? OLLAMA_MODEL ?? '';
    logger.info({ model }, '[intent] initializing classifier');
    _classifier = new LLMIntentClassifier({
      modelId: model,
      cacheEnabled: true,
      cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      fallbackIntent: 'unknown',
    });
  }
  return _classifier;
}

/**
 * Classify intent with a hard timeout. Returns null on timeout or error (= use all tools).
 * Confidence < 0.6 is treated as unconfident and returns null too.
 */
export async function classifyIntent(
  message: string,
): Promise<IntentResult | null> {
  try {
    const result = await Promise.race([
      getClassifier().classify(message),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), CLASSIFY_TIMEOUT_MS + 500),
      ),
    ]);
    if (!result) {
      logger.warn('[intent] classification timed out, using all tools');
      return null;
    }
    if (result.confidence < 0.6) {
      logger.info(
        { intent: result.intent, confidence: result.confidence },
        '[intent] confidence too low (<0.6), using all tools',
      );
      return null;
    }
    return result;
  } catch (err) {
    logger.warn({ err }, '[intent] classifyIntent threw, using all tools');
    return null;
  }
}

export default LLMIntentClassifier;
