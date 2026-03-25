import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const RUNTIME_CONFIG_PATH = path.join(DATA_DIR, 'runtime-config.json');

loadEnv(path.join(__dirname, '.env'));

const PORT = toPositiveInt(process.env.PORT, 3000);
const RESPONSES_URL = process.env.RESPONSES_URL || 'https://example.com/responses';
const RELAY_API_KEY = process.env.RELAY_API_KEY || '';
const MAX_BODY_BYTES = toPositiveInt(process.env.MAX_BODY_BYTES, 25_000_000);

const baseConfig = {
  defaultModel: process.env.DEFAULT_MODEL || 'gpt-5.4',
  defaultInstructions: decodePromptEnv(
    process.env.DEFAULT_INSTRUCTIONS || 'You are a pragmatic coding assistant.',
  ),
  gatewayPromptMode: parseGatewayPromptMode(process.env.GATEWAY_PROMPT_MODE || 'prepend'),
  gatewaySystemPrompt: decodePromptEnv(process.env.GATEWAY_SYSTEM_PROMPT || ''),
  defaultExtraBody: parseJsonEnv(process.env.DEFAULT_EXTRA_BODY_JSON, {}),
  upstreamHeaders: parseJsonEnv(process.env.UPSTREAM_HEADERS_JSON, {}),
};

let runtimeConfig = loadRuntimeConfigSync(RUNTIME_CONFIG_PATH);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const isGetLike = req.method === 'GET' || req.method === 'HEAD';

  try {
    if (isGetLike && url.pathname === '/') {
      await serveFile(res, path.join(PUBLIC_DIR, 'index.html'), req.method === 'HEAD');
      return;
    }

    if (isGetLike && url.pathname === '/admin') {
      await serveFile(res, path.join(PUBLIC_DIR, 'admin.html'), req.method === 'HEAD');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      sendJson(res, 200, buildClientConfig());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/config') {
      sendJson(res, 200, buildAdminConfig());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/config') {
      await handleAdminConfigUpdate(req, res);
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/api/admin/config') {
      await handleAdminConfigReset(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        endpoint: RESPONSES_URL,
        hasApiKey: Boolean(RELAY_API_KEY),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      await handleChat(req, res);
      return;
    }

    if (isGetLike) {
      const filePath = safePublicPath(url.pathname);
      if (filePath) {
        await serveFile(res, filePath, req.method === 'HEAD');
        return;
      }
    }

    sendJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    if (!res.headersSent) {
      sendJson(res, statusCode, {
        error: statusCode >= 500 ? 'Internal server error.' : error.message,
      });
      return;
    }
    res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Responses Chat Studio listening on http://127.0.0.1:${PORT}`);
});

async function handleChat(req, res) {
  if (!RELAY_API_KEY) {
    sendJson(res, 500, {
      error: 'RELAY_API_KEY is not configured. Create a .env file first.',
    });
    return;
  }

  const appConfig = getResolvedConfig();
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const messages = normalizeMessages(body.messages);
  const model = asNonEmptyString(body.model) || appConfig.defaultModel;
  const userInstructions = asNonEmptyString(body.instructions) || appConfig.defaultInstructions;
  const instructions = mergeInstructions(
    userInstructions,
    appConfig.gatewaySystemPrompt,
    appConfig.gatewayPromptMode,
  );
  const extraBody = isPlainObject(body.extraBody) ? body.extraBody : appConfig.defaultExtraBody;
  const maxOutputTokens = toPositiveInt(body.maxOutputTokens, null);
  const promptCacheKey = asNonEmptyString(body.promptCacheKey);
  const promptCacheRetention = asNonEmptyString(body.promptCacheRetention);
  const sessionId = asNonEmptyString(body.sessionId) || crypto.randomUUID();
  const clientRequestId = asNonEmptyString(body.clientRequestId) || sessionId;

  const payload = {
    ...extraBody,
    model,
    instructions,
    input: messages.map((message) => ({
      type: 'message',
      role: message.role,
      content: buildUpstreamContent(message),
    })),
    stream: true,
  };

  if (maxOutputTokens) {
    payload.max_output_tokens = maxOutputTokens;
  }

  const promptCacheNamespace =
    extractPromptCacheNamespace(payload.prompt_cache_key) ||
    extractPromptCacheNamespace(promptCacheKey) ||
    sessionId;

  if (promptCacheNamespace) {
    payload.prompt_cache_key = buildPromptCacheKey(promptCacheNamespace, model, instructions);
  }

  if (!payload.prompt_cache_retention && promptCacheRetention) {
    payload.prompt_cache_retention = promptCacheRetention;
  }

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  const upstreamHeaders = {
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'x-client-request-id': clientRequestId,
    session_id: sessionId,
    originator: 'responses_chat_studio',
    ...appConfig.upstreamHeaders,
    authorization: `Bearer ${RELAY_API_KEY}`,
  };

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });
  } catch (error) {
    const message = isAbortError(error)
      ? 'Client closed the request before the upstream stream finished.'
      : `Failed to reach upstream: ${error.message}`;
    sendJson(res, isAbortError(error) ? 499 : 502, { error: message });
    return;
  }

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text();
    const upstreamMessage = extractUpstreamErrorMessage(errorText);
    sendJson(res, upstreamResponse.status, {
      error: upstreamMessage || 'Upstream request failed.',
      status: upstreamResponse.status,
      body: errorText,
    });
    return;
  }

  if (!upstreamResponse.body) {
    sendJson(res, 502, { error: 'Upstream returned no response body.' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': upstreamResponse.headers.get('content-type') || 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'x-upstream-request-id': upstreamResponse.headers.get('x-request-id') || '',
  });

  const reader = upstreamResponse.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      res.write(Buffer.from(value));
    }
  } catch (error) {
    if (!isAbortError(error) && !res.writableEnded) {
      res.write(
        formatSseEvent('relay.error', {
          message: `Upstream stream interrupted: ${error.message}`,
        }),
      );
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

async function handleAdminConfigUpdate(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const nextConfig = sanitizeRuntimeConfig(body);
  runtimeConfig = nextConfig;
  await persistRuntimeConfig(runtimeConfig);
  sendJson(res, 200, {
    ok: true,
    ...buildAdminConfig(),
  });
}

async function handleAdminConfigReset(res) {
  runtimeConfig = {};
  await persistRuntimeConfig(runtimeConfig);
  sendJson(res, 200, {
    ok: true,
    ...buildAdminConfig(),
  });
}

function buildClientConfig() {
  const config = getResolvedConfig();
  return {
    endpoint: RESPONSES_URL,
    defaultModel: config.defaultModel,
    defaultInstructions: config.defaultInstructions,
    defaultExtraBody: config.defaultExtraBody,
    hasApiKey: Boolean(RELAY_API_KEY),
    hasGatewaySystemPrompt: Boolean(config.gatewaySystemPrompt),
    gatewayPromptMode: config.gatewayPromptMode,
    adminPath: '/admin',
  };
}

function buildAdminConfig() {
  const config = getResolvedConfig();
  return {
    endpoint: RESPONSES_URL,
    hasApiKey: Boolean(RELAY_API_KEY),
    config,
    persistedOverrides: runtimeConfig,
  };
}

function getResolvedConfig() {
  return {
    defaultModel: resolveConfigValue('defaultModel', baseConfig.defaultModel),
    defaultInstructions: resolveConfigValue('defaultInstructions', baseConfig.defaultInstructions),
    gatewayPromptMode: parseGatewayPromptMode(
      resolveConfigValue('gatewayPromptMode', baseConfig.gatewayPromptMode),
    ),
    gatewaySystemPrompt: resolveConfigValue('gatewaySystemPrompt', baseConfig.gatewaySystemPrompt),
    defaultExtraBody: resolveObjectConfigValue('defaultExtraBody', baseConfig.defaultExtraBody),
    upstreamHeaders: baseConfig.upstreamHeaders,
  };
}

function resolveConfigValue(key, fallback) {
  return Object.hasOwn(runtimeConfig, key) ? runtimeConfig[key] : fallback;
}

function resolveObjectConfigValue(key, fallback) {
  const value = resolveConfigValue(key, fallback);
  return isPlainObject(value) ? value : fallback;
}

function sanitizeRuntimeConfig(input) {
  if (!isPlainObject(input)) {
    throw Object.assign(new Error('Admin config body must be a JSON object.'), {
      statusCode: 400,
    });
  }

  const next = {};

  if (Object.hasOwn(input, 'defaultModel')) {
    next.defaultModel = asNonEmptyString(input.defaultModel) || baseConfig.defaultModel;
  }

  if (Object.hasOwn(input, 'defaultInstructions')) {
    next.defaultInstructions = asString(input.defaultInstructions);
  }

  if (Object.hasOwn(input, 'gatewayPromptMode')) {
    next.gatewayPromptMode = parseGatewayPromptMode(input.gatewayPromptMode);
  }

  if (Object.hasOwn(input, 'gatewaySystemPrompt')) {
    next.gatewaySystemPrompt = asString(input.gatewaySystemPrompt);
  }

  if (Object.hasOwn(input, 'defaultExtraBody')) {
    if (!isPlainObject(input.defaultExtraBody)) {
      throw Object.assign(new Error('defaultExtraBody must be a JSON object.'), {
        statusCode: 400,
      });
    }
    next.defaultExtraBody = input.defaultExtraBody;
  }

  return next;
}

function loadRuntimeConfigSync(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function persistRuntimeConfig(config) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(RUNTIME_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function loadEnv(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const source = readFileSync(filePath, 'utf8');
  const lines = source.split(/\r?\n/);
  const assignmentPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)=/;
  const multilineKeys = new Set(['DEFAULT_INSTRUCTIONS', 'GATEWAY_SYSTEM_PROMPT']);

  let pendingKey = null;
  let pendingValueLines = [];

  const commitValue = (key, value) => {
    if (key in process.env) {
      return;
    }

    process.env[key] = stripQuotes(value.trim());
  };

  const flushPending = () => {
    if (!pendingKey) {
      return;
    }

    commitValue(pendingKey, pendingValueLines.join('\n'));
    pendingKey = null;
    pendingValueLines = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const assignmentMatch = rawLine.match(assignmentPattern);

    if (assignmentMatch) {
      flushPending();
      const separatorIndex = rawLine.indexOf('=');
      const key = assignmentMatch[1];
      const initialValue = rawLine.slice(separatorIndex + 1).trim();

      if (multilineKeys.has(key)) {
        pendingKey = key;
        pendingValueLines = [initialValue];
      } else {
        commitValue(key, initialValue);
      }
      continue;
    }

    if (!pendingKey) {
      continue;
    }

    if (!trimmed) {
      pendingValueLines.push('');
      continue;
    }

    if (trimmed.startsWith('#')) {
      pendingValueLines.push(rawLine);
      continue;
    }

    pendingValueLines.push(rawLine);
  }

  flushPending();
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function decodePromptEnv(value) {
  return String(value)
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

function parseJsonEnv(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseGatewayPromptMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'append' || normalized === 'replace') {
    return normalized;
  }
  return 'prepend';
}

function toPositiveInt(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function mergeInstructions(userInstructions, gatewayPrompt, mode) {
  const userText = asNonEmptyString(userInstructions);
  const gatewayText = asNonEmptyString(gatewayPrompt);

  if (!gatewayText) {
    return userText;
  }

  if (mode === 'replace') {
    return gatewayText;
  }

  if (!userText) {
    return gatewayText;
  }

  if (mode === 'append') {
    return `${userText}\n\n${gatewayText}`;
  }

  return `${gatewayText}\n\n${userText}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractPromptCacheNamespace(value) {
  const text = asNonEmptyString(value);
  if (!text) {
    return '';
  }

  const separatorIndex = text.indexOf(':');
  return separatorIndex > 0 ? text.slice(0, separatorIndex) : text;
}

function buildPromptCacheKey(namespace, model, instructions) {
  const signature = crypto
    .createHash('sha256')
    .update(`${model}\n${instructions}`)
    .digest('hex')
    .slice(0, 16);

  return `${namespace}:${signature}`;
}

function normalizeMessages(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  const messages = [];

  for (const item of input) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const role = item.role === 'assistant' ? 'assistant' : 'user';
    const parts = normalizeContentParts(item.parts, item.text);
    if (!parts.length) {
      continue;
    }

    messages.push({ role, parts });
  }

  return messages;
}

function buildUpstreamContent(message) {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const content = [];

  for (const part of message.parts) {
    if (role === 'assistant') {
      if (part.type === 'input_text' || part.type === 'output_text') {
        const text = asNonEmptyString(part.text);
        if (text) {
          content.push({
            type: 'output_text',
            text,
          });
        }
      }
      continue;
    }

    if (part.type === 'input_text') {
      const text = asNonEmptyString(part.text);
      if (text) {
        content.push({
          type: 'input_text',
          text,
        });
      }
      continue;
    }

    if (part.type === 'input_image' && isAllowedImageUrl(part.image_url)) {
      content.push({
        type: 'input_image',
        image_url: part.image_url,
        detail: asNonEmptyString(part.detail) || 'auto',
      });
    }
  }

  return content;
}

function normalizeContentParts(parts, fallbackText = '') {
  const normalized = [];

  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!part || typeof part !== 'object') {
        continue;
      }

      if (part.type === 'input_text') {
        const text = asNonEmptyString(part.text);
        if (text) {
          normalized.push({
            type: 'input_text',
            text,
          });
        }
        continue;
      }

      if (part.type === 'input_image') {
        const imageUrl = asNonEmptyString(part.image_url);
        if (!imageUrl || !isAllowedImageUrl(imageUrl)) {
          continue;
        }
        normalized.push({
          type: 'input_image',
          image_url: imageUrl,
          detail: asNonEmptyString(part.detail) || 'auto',
        });
      }
    }
  }

  if (!normalized.length) {
    const text = asNonEmptyString(fallbackText);
    if (text) {
      normalized.push({
        type: 'input_text',
        text,
      });
    }
  }

  return normalized;
}

function isAllowedImageUrl(value) {
  return /^data:image\//.test(value) || /^https?:\/\//.test(value);
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw Object.assign(new Error('Request body too large.'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body.'), { statusCode: 400 });
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function serveFile(res, filePath, headOnly = false) {
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Cache-Control': filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
    });
    res.end(headOnly ? undefined : data);
  } catch {
    sendJson(res, 404, { error: 'File not found.' });
  }
}

function safePublicPath(requestPath) {
  const cleaned = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
  const target = path.join(PUBLIC_DIR, cleaned);
  if (!target.startsWith(PUBLIC_DIR)) {
    return null;
  }
  if (!existsSync(target)) {
    return null;
  }
  return target;
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  return types[extension] || 'application/octet-stream';
}

function formatSseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function extractUpstreamErrorMessage(errorText) {
  try {
    const parsed = JSON.parse(errorText);
    return (
      parsed?.error?.message ||
      parsed?.message ||
      ''
    );
  } catch {
    return '';
  }
}
