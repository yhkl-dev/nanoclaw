import { describe, it, expect, beforeEach } from 'vitest';
import {
  selectOllamaModel,
  getOllamaModelRoutes,
  _resetOllamaModelRoutesCache,
} from './ollama-router.js';

beforeEach(() => {
  _resetOllamaModelRoutesCache();
});

describe('ollama-router', () => {
  it('returns default model when no routes configured', () => {
    _resetOllamaModelRoutesCache({ routes: '', defaultModel: 'llama3' });
    expect(selectOllamaModel('hello world')).toBe('llama3');
  });

  it('returns per-group model when provided', () => {
    _resetOllamaModelRoutesCache({ routes: 'code:codellama', defaultModel: 'llama3' });
    expect(selectOllamaModel('write some code', 'mistral')).toBe('mistral');
  });

  it('matches keyword route (case-insensitive)', () => {
    _resetOllamaModelRoutesCache({ routes: 'code:codellama,image:llava', defaultModel: 'llama3' });
    expect(selectOllamaModel('Write CODE for me')).toBe('codellama');
    expect(selectOllamaModel('describe this IMAGE')).toBe('llava');
  });

  it('falls back to default model when no route matches', () => {
    _resetOllamaModelRoutesCache({ routes: 'code:codellama', defaultModel: 'llama3' });
    expect(selectOllamaModel('tell me a joke')).toBe('llama3');
  });

  it('returns first matching route', () => {
    _resetOllamaModelRoutesCache({ routes: 'code:codellama,python:mistral', defaultModel: 'llama3' });
    // "code" appears before "python" in routes
    expect(selectOllamaModel('write python code')).toBe('codellama');
  });
});

describe('getOllamaModelRoutes parsing', () => {
  it('parses valid routes', () => {
    _resetOllamaModelRoutesCache({ routes: 'code:codellama, image:llava,think:qwen3' });
    const routes = getOllamaModelRoutes();
    expect(routes).toEqual([
      { keyword: 'code', model: 'codellama' },
      { keyword: 'image', model: 'llava' },
      { keyword: 'think', model: 'qwen3' },
    ]);
  });

  it('skips malformed entries', () => {
    _resetOllamaModelRoutesCache({ routes: 'code:codellama,badentry,:nokey,nomodel:' });
    const routes = getOllamaModelRoutes();
    expect(routes).toEqual([{ keyword: 'code', model: 'codellama' }]);
  });

  it('returns empty array when no routes string', () => {
    _resetOllamaModelRoutesCache({ routes: '' });
    expect(getOllamaModelRoutes()).toEqual([]);
  });
});
