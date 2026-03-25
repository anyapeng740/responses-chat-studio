const elements = {
  adminApiKeyInfo: document.querySelector('#adminApiKeyInfo'),
  adminEndpointValue: document.querySelector('#adminEndpointValue'),
  adminErrorText: document.querySelector('#adminErrorText'),
  adminForm: document.querySelector('#adminForm'),
  adminStatusBadge: document.querySelector('#adminStatusBadge'),
  defaultExtraBody: document.querySelector('#defaultExtraBody'),
  defaultInstructions: document.querySelector('#defaultInstructions'),
  defaultModel: document.querySelector('#defaultModel'),
  gatewayPromptMode: document.querySelector('#gatewayPromptMode'),
  gatewaySystemPrompt: document.querySelector('#gatewaySystemPrompt'),
  reloadButton: document.querySelector('#reloadButton'),
  resetButton: document.querySelector('#resetButton'),
};

boot();

async function boot() {
  bindEvents();
  await refreshConfig();
}

function bindEvents() {
  elements.adminForm.addEventListener('submit', onSubmit);
  elements.reloadButton.addEventListener('click', refreshConfig);
  elements.resetButton.addEventListener('click', onReset);
}

async function refreshConfig() {
  setStatus('读取中');
  hideError();

  try {
    const response = await fetch('/api/admin/config');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    renderConfig(payload);
    setStatus('已加载');
  } catch (error) {
    showError(`读取失败: ${error.message}`);
    setStatus('读取失败');
  }
}

function renderConfig(payload) {
  const config = payload.config || {};
  elements.adminEndpointValue.textContent = payload.endpoint || '未配置';
  elements.adminApiKeyInfo.textContent = payload.hasApiKey ? '密钥状态：已配置' : '密钥状态：未配置';
  elements.gatewayPromptMode.value = config.gatewayPromptMode || 'prepend';
  elements.gatewaySystemPrompt.value = config.gatewaySystemPrompt || '';
  elements.defaultModel.value = config.defaultModel || '';
  elements.defaultInstructions.value = config.defaultInstructions || '';
  elements.defaultExtraBody.value = JSON.stringify(config.defaultExtraBody || {}, null, 2);
}

async function onSubmit(event) {
  event.preventDefault();
  hideError();
  setStatus('保存中');

  let defaultExtraBody;
  try {
    defaultExtraBody = parseJsonObject(elements.defaultExtraBody.value);
  } catch (error) {
    showError(error.message);
    setStatus('保存失败');
    return;
  }

  try {
    const response = await fetch('/api/admin/config', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        gatewayPromptMode: elements.gatewayPromptMode.value,
        gatewaySystemPrompt: elements.gatewaySystemPrompt.value,
        defaultModel: elements.defaultModel.value,
        defaultInstructions: elements.defaultInstructions.value,
        defaultExtraBody,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    renderConfig(payload);
    setStatus('已保存');
  } catch (error) {
    showError(`保存失败: ${error.message}`);
    setStatus('保存失败');
  }
}

async function onReset() {
  hideError();
  setStatus('重置中');

  try {
    const response = await fetch('/api/admin/config', {
      method: 'DELETE',
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    renderConfig(payload);
    setStatus('已重置');
  } catch (error) {
    showError(`重置失败: ${error.message}`);
    setStatus('重置失败');
  }
}

function parseJsonObject(source) {
  if (!source.trim()) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('默认额外请求 JSON 不是合法 JSON。');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('默认额外请求 JSON 必须是对象。');
  }

  return parsed;
}

function setStatus(text) {
  elements.adminStatusBadge.textContent = text;
}

function showError(message) {
  elements.adminErrorText.hidden = false;
  elements.adminErrorText.textContent = message;
}

function hideError() {
  elements.adminErrorText.hidden = true;
  elements.adminErrorText.textContent = '';
}
