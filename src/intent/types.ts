// 意图类型定义

export type Intent =
  | 'chat'
  | 'search_web'
  | 'search_files'
  | 'browse_web'
  | 'read_file'
  | 'write_file'
  | 'run_bash'
  | 'bash_exec'
  | 'schedule_task'
  | 'send_email'
  | 'read_email'
  | 'gmail_list'
  | 'gmail_read'
  | 'gmail_search'
  | 'gmail_send'
  | 'calendar_list'
  | 'calendar_create'
  | 'calendar_delete'
  | 'tavily_search'
  | 'system_stats'
  | 'browser_open'
  | 'browser_snapshot'
  | 'browser_click'
  | 'browser_type'
  | 'browser_get_text'
  | 'browser_get_html'
  | 'browser_get_value'
  | 'browser_get_attr'
  | 'browser_get_count'
  | 'browser_get_title'
  | 'browser_get_url'
  | 'browser_close'
  | 'unknown';

export interface IntentResult {
  intent: Intent;
  confidence: number;
  recommended_engine?: 'local' | 'claude'; // Added field
  entities?: {
    [key: string]: string;
  };
  rawPrompt?: string;
}

export interface LLMClassifierConfig {
  modelId: string;
  apiKey?: string;
  cacheEnabled: boolean;
  cacheTtlMs: number;
  fallbackIntent: Intent;
}

export interface ClassifierStats {
  totalRequests: number;
  cachedRequests: number;
  llmRequests: number;
  averageLatencyMs: number;
  intentsUsed: Map<string, number>;
}
