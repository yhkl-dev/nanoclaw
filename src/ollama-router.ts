import { OLLAMA_MODEL, OLLAMA_MODEL_ROUTES } from './config.js';

export interface OllamaModelRoute {
  keyword: string;
  model: string;
}

let parsedRoutes: OllamaModelRoute[] | undefined;
// Injected during tests to bypass module-level const binding
let _testRoutesOverride: string | null = null;
let _testModelOverride: string | null = null;

function getRoutesString(): string | undefined {
  return _testRoutesOverride !== null ? _testRoutesOverride : OLLAMA_MODEL_ROUTES;
}

function getDefaultModel(): string | undefined {
  return _testModelOverride !== null ? _testModelOverride : OLLAMA_MODEL;
}

/**
 * Parse the OLLAMA_MODEL_ROUTES env string into a list of keyword→model pairs.
 * Format: "keyword1:model1,keyword2:model2"
 * Parses lazily and caches the result.
 */
export function getOllamaModelRoutes(): OllamaModelRoute[] {
  if (parsedRoutes !== undefined) return parsedRoutes;
  const routesStr = getRoutesString();
  if (!routesStr) {
    parsedRoutes = [];
    return parsedRoutes;
  }
  parsedRoutes = routesStr
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const colonIdx = entry.indexOf(':');
      if (colonIdx <= 0) return null;
      const keyword = entry.slice(0, colonIdx).trim().toLowerCase();
      const model = entry.slice(colonIdx + 1).trim();
      if (!keyword || !model) return null;
      return { keyword, model };
    })
    .filter((r): r is OllamaModelRoute => r !== null);
  return parsedRoutes;
}

/**
 * Select the Ollama model to use for a given prompt.
 *
 * Priority:
 * 1. Per-group model override (groupModel param)
 * 2. Keyword routing rules (OLLAMA_MODEL_ROUTES)
 * 3. Default model (OLLAMA_MODEL)
 */
export function selectOllamaModel(
  prompt: string,
  groupModel?: string,
): string | undefined {
  if (groupModel) return groupModel;

  const routes = getOllamaModelRoutes();
  if (routes.length > 0) {
    const lower = prompt.toLowerCase();
    for (const route of routes) {
      if (lower.includes(route.keyword)) {
        return route.model;
      }
    }
  }

  return getDefaultModel();
}

// Exported for testing only — reset the lazy cache so tests can vary config.
export function _resetOllamaModelRoutesCache(
  opts: { routes?: string; defaultModel?: string } = {},
): void {
  parsedRoutes = undefined;
  _testRoutesOverride = 'routes' in opts ? (opts.routes ?? '') : null;
  _testModelOverride = 'defaultModel' in opts ? (opts.defaultModel ?? null) : null;
}
