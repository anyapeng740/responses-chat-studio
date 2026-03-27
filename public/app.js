const sessionKey = 'responses-chat-studio.session-id';
const currentConversationKey = 'responses-chat-studio.current-conversation-id';
const currentModeKey = 'responses-chat-studio.current-mode';
const profileKey = 'responses-chat-studio.profile-id';
const relayAccessModeStorageKey = 'responses-chat-studio.relay-access-mode';
const relayApiKeyStorageKey = 'responses-chat-studio.relay-api-key';
const maxImageCount = 4;
const maxFileBytes = 4 * 1024 * 1024;
const historyDbName = 'responses-chat-studio-db';
const historyStoreName = 'conversations';
const maxHistoryItems = 50;
const configApiPath = 'api/config';
const chatApiPath = 'api/chat';
const conversationModes = Object.freeze({
  chat: {
    label: '聊天',
    description: '像平时一样直接聊，回答会更像自然对话。',
    emptyState: '从下面开始发第一条消息，随便聊就行。',
    emptyTitle: '新对话',
    inputPlaceholder: '输入消息，可与图片一起发送；按 Cmd/Ctrl + Enter 发送',
  },
  prompt_optimizer: {
    label: 'Prompt 优化',
    description: '把编程需求整理成更适合 AI Coding Assistant 执行的 prompt。',
    emptyState: '描述你的编程目标、当前问题、相关代码范围和预期结果。',
    emptyTitle: 'Prompt 优化',
    inputPlaceholder: '描述你的编程需求、上下文、现状和预期结果，我来帮你整理 prompt',
  },
});
const markdownRenderer =
  typeof window !== 'undefined' && typeof window.markdownit === 'function'
    ? window.markdownit({
        html: false,
        breaks: true,
        linkify: true,
      })
    : null;

let historyDbPromise = null;
let persistTimer = null;

const state = {
  endpoint: '',
  currentMode: 'chat',
  historyScope: 'no-key',
  accessMode: 'own',
  hasPublicRelayKey: false,
  profileId: '',
  relayApiKey: '',
  hasApiKey: false,
  isStreaming: false,
  abortController: null,
  sessionId: '',
  currentConversationId: '',
  currentConversationCreatedAt: Date.now(),
  hasGatewaySystemPrompt: false,
  gatewayPromptMode: 'prepend',
  defaultModel: 'gpt-5.4',
  defaultInstructionsByMode: {
    chat: '',
    prompt_optimizer: '',
  },
  defaultExtraBody: {},
  attachments: [],
  messages: [],
  history: [],
};

const elements = {
  attachments: document.querySelector('#attachments'),
  composerForm: document.querySelector('#composerForm'),
  conversationTitle: document.querySelector('#conversationTitle'),
  errorText: document.querySelector('#errorText'),
  globalSettingsButton: document.querySelector('#globalSettingsButton'),
  gatewayPromptInfo: document.querySelector('#gatewayPromptInfo'),
  historyEmpty: document.querySelector('#historyEmpty'),
  historyList: document.querySelector('#historyList'),
  historyNewButton: document.querySelector('#historyNewButton'),
  imageInput: document.querySelector('#imageInput'),
  messageInput: document.querySelector('#messageInput'),
  messages: document.querySelector('#messages'),
  modeDescription: document.querySelector('#modeDescription'),
  modeTabs: document.querySelector('#modeTabs'),
  newChatButton: document.querySelector('#newChatButton'),
  publicRelayHint: document.querySelector('#publicRelayHint'),
  relayAccessModeOwn: document.querySelector('#relayAccessModeOwn'),
  relayAccessModePublic: document.querySelector('#relayAccessModePublic'),
  relayApiKeyErrorText: document.querySelector('#relayApiKeyErrorText'),
  relayApiKeyField: document.querySelector('#relayApiKeyField'),
  relayApiKeyForm: document.querySelector('#relayApiKeyForm'),
  relayApiKeyInfo: document.querySelector('#relayApiKeyInfo'),
  relayApiKeyInput: document.querySelector('#relayApiKeyInput'),
  relayApiKeySaveButton: document.querySelector('#relayApiKeySaveButton'),
  relayApiKeyState: document.querySelector('#relayApiKeyState'),
  sendButton: document.querySelector('#sendButton'),
  sessionSummary: document.querySelector('#sessionSummary'),
  settingsDrawer: document.querySelector('#settingsDrawer'),
  settingsDrawerBackdrop: document.querySelector('#settingsDrawerBackdrop'),
  settingsDrawerCloseButton: document.querySelector('#settingsDrawerCloseButton'),
  statusBadge: document.querySelector('#statusBadge'),
  stopButton: document.querySelector('#stopButton'),
};

boot();

async function boot() {
  bindEvents();
  hydrateRuntime();
  setStatus('初始化中');

  try {
    const config = await fetchConfig();
    hydrateConfig(config);
    renderRelayApiKeySettings();
    await refreshHistoryForCurrentScope();
    renderApp();
    setStatus('空闲');
  } catch (error) {
    showError(`加载失败: ${error.message}`);
    state.history = [];
    createBlankConversation();
    renderRelayApiKeySettings('读取配置失败，暂时无法保存 key。');
    renderApp();
    setStatus('配置错误');
  }
}

function bindEvents() {
  elements.composerForm.addEventListener('submit', onSubmit);
  elements.globalSettingsButton.addEventListener('click', openSettingsDrawer);
  elements.messageInput.addEventListener('keydown', onComposerKeydown);
  elements.messageInput.addEventListener('paste', onComposerPaste);
  elements.imageInput.addEventListener('change', onImageChange);
  elements.attachments.addEventListener('click', onAttachmentClick);
  elements.stopButton.addEventListener('click', stopStream);
  elements.newChatButton.addEventListener('click', () => startNewConversation(true));
  elements.historyNewButton.addEventListener('click', () => startNewConversation(true));
  elements.historyList.addEventListener('click', onHistoryListClick);
  elements.modeTabs.addEventListener('click', onModeTabsClick);
  elements.relayApiKeyForm.addEventListener('submit', onRelayApiKeySubmit);
  elements.settingsDrawerBackdrop.addEventListener('click', closeSettingsDrawer);
  elements.settingsDrawerCloseButton.addEventListener('click', closeSettingsDrawer);
  document.addEventListener('keydown', onDocumentKeydown);
}

async function fetchConfig() {
  const response = await fetch(configApiPath);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function hydrateRuntime() {
  state.profileId = getOrCreateLocalValue(profileKey);
  state.sessionId = getOrCreateLocalValue(sessionKey);
  state.currentMode = normalizeMode(localStorage.getItem(currentModeKey));
  state.accessMode = normalizeRelayAccessMode(localStorage.getItem(relayAccessModeStorageKey));
  state.relayApiKey = localStorage.getItem(relayApiKeyStorageKey) || '';
  syncRelayAccessState();
  state.historyScope = buildHistoryScope();
}

function hydrateConfig(config) {
  state.endpoint = config.endpoint;
  state.hasPublicRelayKey = Boolean(config.hasPublicRelayKey);
  state.hasGatewaySystemPrompt = Boolean(config.hasGatewaySystemPrompt);
  state.gatewayPromptMode = config.gatewayPromptMode || 'prepend';
  state.defaultModel = config.defaultModel || 'gpt-5.4';
  state.defaultInstructionsByMode = normalizeInstructionsByMode(config);
  state.defaultExtraBody =
    config.defaultExtraBody && typeof config.defaultExtraBody === 'object' ? config.defaultExtraBody : {};
  syncRelayAccessState();
}

function restoreCurrentConversation() {
  const savedId = localStorage.getItem(currentConversationKey);
  const existing = state.history.find((conversation) => conversation.id === savedId);

  if (existing) {
    loadConversation(existing.id, false);
    return;
  }

  createBlankConversation();
}

function renderApp() {
  renderHeader();
  renderAttachments();
  renderMessages();
  renderHistoryList();
}

function renderHeader() {
  renderModeControls();
  elements.gatewayPromptInfo.textContent = state.hasGatewaySystemPrompt
    ? `网关系统提示词：已启用（${state.gatewayPromptMode}）`
    : '网关系统提示词：未启用';
  elements.conversationTitle.textContent = deriveConversationTitle(state.messages, state.currentMode);
  elements.sessionSummary.textContent = buildSessionSummary();
}

function renderModeControls() {
  const modeMeta = getModeMeta();
  const tabButtons = elements.modeTabs ? elements.modeTabs.querySelectorAll('[data-mode]') : [];

  for (const button of tabButtons) {
    const isActive = normalizeMode(button.dataset.mode) === state.currentMode;
    button.classList.toggle('mode-tab--active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  }

  if (elements.modeDescription) {
    elements.modeDescription.textContent = modeMeta.description;
  }
  elements.messageInput.placeholder = modeMeta.inputPlaceholder;
}

function renderRelayApiKeySettings(infoText = '') {
  elements.relayAccessModeOwn.checked = state.accessMode === 'own';
  elements.relayAccessModePublic.checked = state.accessMode === 'public';
  elements.relayAccessModePublic.disabled = !state.hasPublicRelayKey;
  elements.publicRelayHint.textContent = state.hasPublicRelayKey
    ? ''
    : '当前服务端没有可用的默认 key，所以只能使用自己的 key。';
  elements.relayApiKeyField.hidden = state.accessMode === 'public';
  elements.relayApiKeyInput.value = state.relayApiKey;
  elements.relayApiKeyState.textContent = state.accessMode === 'public'
    ? state.hasPublicRelayKey
      ? '公益模式'
      : '未配置'
    : state.hasApiKey
      ? '已配置'
      : '未配置';
  elements.relayApiKeyState.className = `mini-badge ${state.hasApiKey ? 'mini-badge--ok' : 'mini-badge--warn'}`;
  elements.relayApiKeyInfo.textContent =
    infoText ||
    buildRelayAccessInfoText();
}

function renderAttachments() {
  elements.attachments.innerHTML = '';
  elements.attachments.hidden = state.attachments.length === 0;

  for (const attachment of state.attachments) {
    const card = document.createElement('article');
    card.className = 'attachment-card';
    card.dataset.attachmentId = attachment.id;

    const image = document.createElement('img');
    image.className = 'attachment-card__image';
    image.src = attachment.dataUrl;
    image.alt = attachment.name;

    const meta = document.createElement('div');
    meta.className = 'attachment-card__meta';
    meta.innerHTML = `
      <strong>${escapeHtml(attachment.name)}</strong>
      <span>${formatBytes(attachment.size)}</span>
    `;

    const remove = document.createElement('button');
    remove.className = 'button button--ghost button--inline';
    remove.type = 'button';
    remove.dataset.action = 'remove-attachment';
    remove.dataset.attachmentId = attachment.id;
    remove.textContent = '移除';

    card.append(image, meta, remove);
    elements.attachments.append(card);
  }
}

function renderMessages() {
  elements.messages.innerHTML = '';

  if (!state.messages.length) {
    const modeMeta = getModeMeta();
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `<p>${escapeHtml(modeMeta.emptyState)}</p>`;
    elements.messages.append(empty);
    return;
  }

  for (const message of state.messages) {
    elements.messages.append(createMessageCard(message));
  }

  scrollMessages();
}

function createMessageCard(message) {
  const article = document.createElement('article');
  article.className = `message-card message-card--${message.role}`;
  article.dataset.messageId = message.id;

  const label = document.createElement('div');
  label.className = 'message-card__label';
  label.textContent = message.role === 'user' ? '你' : '助手';
  article.append(label);

  if (Array.isArray(message.parts)) {
    for (const part of message.parts) {
      if (part.type === 'input_text') {
        const text = document.createElement('div');
        text.className = 'message-card__body';
        renderMessageText(text, part.text, message.role);
        article.append(text);
      }

      if (part.type === 'input_image') {
        const figure = document.createElement('figure');
        figure.className = 'message-card__image';

        const image = document.createElement('img');
        image.src = part.image_url;
        image.alt = part.name || 'uploaded image';

        const caption = document.createElement('figcaption');
        caption.textContent = part.name || '图片';

        figure.append(image, caption);
        article.append(figure);
      }
    }

    return article;
  }

  const body = document.createElement('div');
  body.className = 'message-card__body';
  renderMessageText(body, message.text || (message.role === 'assistant' ? '...' : ''), message.role);
  article.append(body);
  return article;
}

function renderHistoryList() {
  elements.historyList.innerHTML = '';
  elements.historyEmpty.hidden = state.history.length > 0;

  for (const conversation of state.history) {
    const item = document.createElement('article');
    item.className = `history-item${
      conversation.id === state.currentConversationId ? ' history-item--active' : ''
    }`;
    item.dataset.conversationId = conversation.id;

    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'history-item__main';
    title.dataset.action = 'load-conversation';
    title.dataset.conversationId = conversation.id;
    const modeMeta = getModeMeta(conversation.mode);
    title.innerHTML = `
      <div class="history-item__topline">
        <strong>${escapeHtml(conversation.title || '未命名对话')}</strong>
        <span class="mini-badge mode-badge">${escapeHtml(modeMeta.label)}</span>
      </div>
      <span>${escapeHtml(conversation.preview || '空白对话')}</span>
      <time>${formatDateTime(conversation.updatedAt)}</time>
    `;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button button--ghost button--inline history-item__delete';
    remove.dataset.action = 'delete-conversation';
    remove.dataset.conversationId = conversation.id;
    remove.textContent = '删除';

    item.append(title, remove);
    elements.historyList.append(item);
  }
}

function renderMessageText(element, text, role) {
  if (role === 'assistant') {
    element.innerHTML = markdownRenderer ? markdownRenderer.render(text || '') : escapeHtml(text || '');
    return;
  }

  element.textContent = text;
}

function onComposerKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    elements.composerForm.requestSubmit();
  }
}

async function onImageChange(event) {
  hideError();
  const files = Array.from(event.target.files || []);
  await addAttachmentFiles(files);
  elements.imageInput.value = '';
  renderAttachments();
}

async function onComposerPaste(event) {
  const clipboardData = event.clipboardData;
  if (!clipboardData) {
    return;
  }

  const imageFiles = Array.from(clipboardData.items || [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);

  if (!imageFiles.length) {
    return;
  }

  event.preventDefault();
  hideError();

  const pastedText = clipboardData.getData('text/plain');
  if (pastedText) {
    insertTextAtCursor(elements.messageInput, pastedText);
  }

  await addAttachmentFiles(
    imageFiles.map((file, index) => ensureAttachmentFileName(file, index + 1)),
  );
  renderAttachments();
}

function onAttachmentClick(event) {
  const button = event.target.closest('[data-action="remove-attachment"]');
  if (!button) {
    return;
  }

  const attachmentId = button.dataset.attachmentId;
  state.attachments = state.attachments.filter((attachment) => attachment.id !== attachmentId);
  renderAttachments();
}

async function addAttachmentFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      showError(`只支持图片文件: ${file.name}`);
      continue;
    }

    if (file.size > maxFileBytes) {
      showError(`图片过大: ${file.name}，请控制在 ${formatBytes(maxFileBytes)} 以内。`);
      continue;
    }

    if (state.attachments.length >= maxImageCount) {
      showError(`最多上传 ${maxImageCount} 张图片。`);
      break;
    }

    const dataUrl = await fileToDataUrl(file);
    state.attachments.push({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      mediaType: file.type,
      dataUrl,
    });
  }
}

async function onSubmit(event) {
  event.preventDefault();
  hideError();

  if (state.isStreaming) {
    return;
  }

  if (!state.hasApiKey) {
    showError(
      state.accessMode === 'public'
        ? '服务端还没有配置公益 key，请先切回自己的 key 或补上公益 key。'
        : '请先在全局设置里保存 RELAY_API_KEY。',
    );
    openSettingsDrawer();
    return;
  }

  const userText = elements.messageInput.value.trim();
  if (!userText && state.attachments.length === 0) {
    return;
  }

  ensureCurrentConversation();

  const userParts = [];
  if (userText) {
    userParts.push({
      type: 'input_text',
      text: userText,
    });
  }

  for (const attachment of state.attachments) {
    userParts.push({
      type: 'input_image',
      image_url: attachment.dataUrl,
      detail: 'auto',
      name: attachment.name,
      mediaType: attachment.mediaType,
      size: attachment.size,
    });
  }

  const userMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    parts: userParts,
  };
  const assistantMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    text: '',
  };

  state.messages.push(userMessage, assistantMessage);
  elements.messageInput.value = '';
  state.attachments = [];
  renderAttachments();
  renderMessages();
  renderHeader();
  scheduleConversationSave();

  await streamResponse(assistantMessage.id);
}

async function streamResponse(assistantMessageId) {
  state.isStreaming = true;
  state.abortController = new AbortController();
  elements.sendButton.disabled = true;
  elements.stopButton.disabled = false;
  setStatus('流式输出中');

  const payload = {
    model: state.defaultModel,
    mode: state.currentMode,
    instructions: getActiveInstructions(),
    relayApiKey: state.accessMode === 'own' ? state.relayApiKey : '',
    usePublicRelayKey: state.accessMode === 'public',
    extraBody: state.defaultExtraBody,
    sessionId: state.sessionId,
    clientRequestId: state.sessionId,
    promptCacheKey: buildPromptCacheKey(),
    messages: state.messages
      .filter((message) => message.id !== assistantMessageId)
      .map((message) => serializeMessage(message)),
  };

  try {
    const response = await fetch(chatApiPath, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: state.abortController.signal,
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(async () => ({
        error: await response.text(),
      }));
      throw new Error(errorPayload.error || `HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error('返回体为空，无法读取流。');
    }

    await consumeSse(response.body, (eventName, data) => {
      handleSseEvent(eventName, data, assistantMessageId);
    });

    if (!state.messages.find((message) => message.id === assistantMessageId)?.text.trim()) {
      updateMessageText(assistantMessageId, '[上游已结束，但没有输出文本]');
    }

    setStatus('已完成');
  } catch (error) {
    if (error.name === 'AbortError') {
      setStatus('已停止');
      if (!state.messages.find((message) => message.id === assistantMessageId)?.text.trim()) {
        updateMessageText(assistantMessageId, '[已手动停止]');
      }
    } else {
      showError(error.message);
      setStatus('出错');
      if (!state.messages.find((message) => message.id === assistantMessageId)?.text.trim()) {
        updateMessageText(assistantMessageId, `[请求失败] ${error.message}`);
      }
    }
  } finally {
    state.isStreaming = false;
    state.abortController = null;
    elements.sendButton.disabled = false;
    elements.stopButton.disabled = true;
    await persistCurrentConversation();
    renderHeader();
  }
}

function serializeMessage(message) {
  if (Array.isArray(message.parts)) {
    return {
      role: message.role,
      parts: message.parts.map((part) => {
        if (part.type === 'input_text') {
          return {
            type: 'input_text',
            text: part.text,
          };
        }

        return {
          type: 'input_image',
          image_url: part.image_url,
          detail: part.detail || 'auto',
        };
      }),
    };
  }

  return {
    role: message.role,
    text: message.text,
  };
}

function handleSseEvent(eventName, data, assistantMessageId) {
  if (eventName === 'response.output_text.delta' && typeof data?.delta === 'string') {
    appendToMessage(assistantMessageId, data.delta);
    scheduleConversationSave();
    return;
  }

  if (eventName === 'relay.error') {
    showError(data?.message || '流中断了。');
    return;
  }

  if (eventName === 'response.failed') {
    const message = data?.response?.error?.message || '上游返回失败事件。';
    showError(message);
  }
}

function updateMessageText(messageId, nextText) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) {
    return;
  }

  message.text = nextText;
  const body = document.querySelector(`[data-message-id="${messageId}"] .message-card__body`);
  if (body) {
    renderMessageText(body, nextText || (message.role === 'assistant' ? '...' : ''), message.role);
  } else {
    renderMessages();
  }
  scrollMessages();
}

function appendToMessage(messageId, chunk) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) {
    return;
  }
  updateMessageText(messageId, `${message.text}${chunk}`);
}

async function consumeSse(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const segments = buffer.split(/\r?\n\r?\n/);
    buffer = segments.pop() || '';

    for (const segment of segments) {
      const parsed = parseSseEvent(segment);
      if (parsed) {
        onEvent(parsed.event, parsed.data);
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseSseEvent(buffer);
    if (parsed) {
      onEvent(parsed.event, parsed.data);
    }
  }
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent.split(/\r?\n/);
  let eventName = 'message';
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  const rawData = dataLines.join('\n');
  try {
    return {
      event: eventName,
      data: JSON.parse(rawData),
    };
  } catch {
    return {
      event: eventName,
      data: rawData,
    };
  }
}

function ensureCurrentConversation() {
  if (state.currentConversationId) {
    return;
  }
  createBlankConversation();
}

function createBlankConversation() {
  state.currentMode = normalizeMode(state.currentMode);
  state.currentConversationId = crypto.randomUUID();
  state.currentConversationCreatedAt = Date.now();
  state.messages = [];
  state.attachments = [];
  state.abortController = null;
  localStorage.setItem(currentConversationKey, state.currentConversationId);
  localStorage.setItem(currentModeKey, state.currentMode);
}

function startNewConversation(focusInput, mode = state.currentMode) {
  if (state.isStreaming) {
    showError('正在生成回复时不能切换到新对话。');
    return;
  }

  hideError();
  state.currentMode = normalizeMode(mode);
  createBlankConversation();
  elements.messageInput.value = '';
  renderApp();
  setStatus('空闲');
  if (focusInput) {
    elements.messageInput.focus();
  }
}

async function onHistoryListClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) {
    return;
  }

  const conversationId = button.dataset.conversationId;
  if (!conversationId) {
    return;
  }

  if (button.dataset.action === 'delete-conversation') {
    await deleteConversation(conversationId);
    return;
  }

  if (button.dataset.action === 'load-conversation') {
    loadConversation(conversationId);
  }
}

function onModeTabsClick(event) {
  const button = event.target.closest('[data-mode]');
  if (!button) {
    return;
  }

  switchMode(button.dataset.mode);
}

function switchMode(nextMode) {
  const normalizedMode = normalizeMode(nextMode);
  if (normalizedMode === state.currentMode) {
    return;
  }

  if (state.isStreaming) {
    showError('正在生成回复时不能切换模式。');
    return;
  }

  hideError();

  if (state.messages.length > 0) {
    startNewConversation(true, normalizedMode);
    return;
  }

  state.currentMode = normalizedMode;
  localStorage.setItem(currentModeKey, state.currentMode);
  renderApp();
  setStatus('空闲');
  elements.messageInput.focus();
}

function openSettingsDrawer() {
  hideRelayApiKeyError();
  renderRelayApiKeySettings();
  elements.settingsDrawer.hidden = false;
  document.body.classList.add('body--drawer-open');
  if (state.accessMode === 'own') {
    elements.relayApiKeyInput.focus();
    elements.relayApiKeyInput.select();
  } else {
    elements.relayAccessModePublic.focus();
  }
}

function closeSettingsDrawer() {
  elements.settingsDrawer.hidden = true;
  document.body.classList.remove('body--drawer-open');
  elements.globalSettingsButton.focus();
}

function onDocumentKeydown(event) {
  if (event.key === 'Escape' && !elements.settingsDrawer.hidden) {
    closeSettingsDrawer();
  }
}

async function onRelayApiKeySubmit(event) {
  event.preventDefault();
  hideRelayApiKeyError();
  elements.relayApiKeySaveButton.disabled = true;
  elements.relayApiKeyInfo.textContent = '保存中...';

  try {
    const previousHistoryScope = state.historyScope;
    const nextAccessMode = normalizeRelayAccessMode(
      document.querySelector('input[name="relayAccessMode"]:checked')?.value,
    );
    const nextRelayApiKey = elements.relayApiKeyInput.value.trim();

    if (nextAccessMode === 'public' && !state.hasPublicRelayKey) {
      throw new Error('服务端没有可用的默认 key。');
    }

    localStorage.setItem(relayAccessModeStorageKey, nextAccessMode);

    if (nextAccessMode === 'own' && nextRelayApiKey) {
      localStorage.setItem(relayApiKeyStorageKey, nextRelayApiKey);
    }

    if (nextAccessMode === 'own' && !nextRelayApiKey) {
      localStorage.removeItem(relayApiKeyStorageKey);
    }

    state.accessMode = nextAccessMode;
    state.relayApiKey = nextRelayApiKey;
    syncRelayAccessState();
    state.historyScope = buildHistoryScope();

    if (state.historyScope !== previousHistoryScope) {
      await refreshHistoryForCurrentScope({ resetConversation: true });
    }

    renderRelayApiKeySettings(
      state.accessMode === 'public'
        ? '已切换到公益 key，并进入公益模式自己的独立聊天记录。'
        : state.hasApiKey
          ? 'Key 已保存到当前浏览器，已切换到该 key 的独立聊天记录。'
          : 'Key 已清空。需要重新输入后才可以继续使用。',
    );
    renderApp();

    if (state.hasApiKey) {
      hideError();
      closeSettingsDrawer();
      elements.messageInput.focus();
    }
  } catch (error) {
    showRelayApiKeyError(`保存失败: ${error.message}`);
    elements.relayApiKeyInfo.textContent = '保存失败，请检查输入后重试。';
  } finally {
    elements.relayApiKeySaveButton.disabled = false;
  }
}

function loadConversation(conversationId) {
  if (state.isStreaming) {
    showError('正在生成回复时不能切换历史记录。');
    return;
  }

  const conversation = state.history.find((item) => item.id === conversationId);
  if (!conversation) {
    return;
  }

  state.currentConversationId = conversation.id;
  state.currentConversationCreatedAt = conversation.createdAt || Date.now();
  state.currentMode = normalizeMode(conversation.mode);
  state.messages = cloneMessages(conversation.messages || []);
  state.attachments = [];
  localStorage.setItem(currentConversationKey, state.currentConversationId);
  localStorage.setItem(currentModeKey, state.currentMode);
  hideError();
  renderApp();
  setStatus('空闲');
}

async function deleteConversation(conversationId) {
  if (state.isStreaming) {
    showError('正在生成回复时不能删除历史记录。');
    return;
  }

  await removeConversationFromDb(conversationId);
  state.history = state.history.filter((conversation) => conversation.id !== conversationId);

  if (state.currentConversationId === conversationId) {
    if (state.history.length) {
      loadConversation(state.history[0].id, false);
    } else {
      createBlankConversation();
      renderApp();
    }
  } else {
    renderHistoryList();
  }
}

function stopStream() {
  state.abortController?.abort();
}

function setStatus(text) {
  elements.statusBadge.textContent = text;
}

function showError(message) {
  elements.errorText.hidden = false;
  elements.errorText.textContent = message;
}

function hideError() {
  elements.errorText.hidden = true;
  elements.errorText.textContent = '';
}

function showRelayApiKeyError(message) {
  elements.relayApiKeyErrorText.hidden = false;
  elements.relayApiKeyErrorText.textContent = message;
}

function hideRelayApiKeyError() {
  elements.relayApiKeyErrorText.hidden = true;
  elements.relayApiKeyErrorText.textContent = '';
}

function buildSessionSummary() {
  const modeMeta = getModeMeta();
  const turnCount = state.messages.filter((message) => message.role === 'user').length;
  const imageCount = state.messages.reduce((total, message) => {
    if (!Array.isArray(message.parts)) {
      return total;
    }
    return total + message.parts.filter((part) => part.type === 'input_image').length;
  }, 0);

  if (!state.messages.length) {
    return modeMeta.description;
  }

  return `${modeMeta.label} · ${turnCount} 轮消息${imageCount ? ` · ${imageCount} 张图` : ''}`;
}

function deriveConversationTitle(messages, mode = state.currentMode) {
  const firstUserText = messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => normalizeMessagePreviewParts(message))
    .find((part) => part.type === 'text' && part.value.trim());

  if (firstUserText) {
    return truncateText(firstUserText.value.trim(), 22);
  }

  const hasImage = messages.some((message) =>
    normalizeMessagePreviewParts(message).some((part) => part.type === 'image'),
  );

  return hasImage ? '图片对话' : getModeMeta(mode).emptyTitle;
}

function deriveConversationPreview(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const parts = normalizeMessagePreviewParts(message);
    const textPart = parts.find((part) => part.type === 'text' && part.value.trim());
    if (textPart) {
      return truncateText(textPart.value.trim(), 48);
    }
    if (parts.some((part) => part.type === 'image')) {
      return '[图片]';
    }
  }

  return '空白对话';
}

function normalizeMessagePreviewParts(message) {
  if (Array.isArray(message.parts)) {
    return message.parts.map((part) => {
      if (part.type === 'input_text') {
        return { type: 'text', value: part.text || '' };
      }
      if (part.type === 'input_image') {
        return { type: 'image', value: part.name || '图片' };
      }
      return { type: 'unknown', value: '' };
    });
  }

  return [{ type: 'text', value: message.text || '' }];
}

function truncateText(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function buildPromptCacheKey() {
  const signature = simpleHash(`${state.currentMode}\n${state.defaultModel}\n${getActiveInstructions()}`);
  return `${state.currentConversationId}:${signature}`;
}

function simpleHash(input) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function scheduleConversationSave() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistCurrentConversation().catch((error) => console.error(error));
  }, 250);
}

async function persistCurrentConversation() {
  clearTimeout(persistTimer);
  persistTimer = null;

  if (!state.currentConversationId || !state.messages.length) {
    renderHistoryList();
    return;
  }

  const record = {
    id: state.currentConversationId,
    createdAt: state.currentConversationCreatedAt,
    updatedAt: Date.now(),
    historyScope: state.historyScope,
    mode: state.currentMode,
    title: deriveConversationTitle(state.messages, state.currentMode),
    preview: deriveConversationPreview(state.messages),
    messages: cloneMessages(state.messages),
  };

  await upsertConversation(record);
  renderHistoryList();
  renderHeader();
}

function cloneMessages(messages) {
  return JSON.parse(JSON.stringify(messages));
}

function getOrCreateLocalValue(key) {
  const existing = localStorage.getItem(key);
  if (existing) {
    return existing;
  }

  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`读取图片失败: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const nextValue = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
  textarea.value = nextValue;
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
}

function ensureAttachmentFileName(file, index) {
  if (file.name) {
    return file;
  }

  const extension = file.type.split('/')[1] || 'png';
  return new File([file], `pasted-image-${index}.${extension}`, {
    type: file.type,
    lastModified: Date.now(),
  });
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDateTime(timestamp) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    return '';
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scrollMessages() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

async function openHistoryDb() {
  if (!('indexedDB' in window)) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(historyDbName, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(historyStoreName)) {
        db.createObjectStore(historyStoreName, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getHistoryDb() {
  if (historyDbPromise === null) {
    historyDbPromise = openHistoryDb();
  }
  return historyDbPromise;
}

async function loadConversations() {
  const scope = state.historyScope;
  const db = await getHistoryDb();
  if (!db) {
    return [];
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(historyStoreName, 'readonly');
    const request = transaction.objectStore(historyStoreName).getAll();
    request.onsuccess = () => {
      const conversations = Array.isArray(request.result) ? request.result : [];
      resolve(
        conversations
          .map((conversation) => normalizeConversationRecord(conversation))
          .filter((conversation) => matchesCurrentHistoryScope(conversation, scope))
          .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
          .slice(0, maxHistoryItems),
      );
    };
    request.onerror = () => reject(request.error);
  });
}

async function upsertConversation(record) {
  const db = await getHistoryDb();
  if (!db) {
    return;
  }

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(historyStoreName, 'readwrite');
    transaction.objectStore(historyStoreName).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });

  const normalizedRecord = normalizeConversationRecord(record);
  const nextHistory = [normalizedRecord, ...state.history.filter((item) => item.id !== record.id)]
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
    .slice(0, maxHistoryItems);

  state.history = nextHistory;
}

async function removeConversationFromDb(conversationId) {
  const db = await getHistoryDb();
  if (!db) {
    return;
  }

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(historyStoreName, 'readwrite');
    transaction.objectStore(historyStoreName).delete(conversationId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function normalizeMode(value) {
  return value === 'prompt_optimizer' ? 'prompt_optimizer' : 'chat';
}

function getModeMeta(mode = state.currentMode) {
  return conversationModes[normalizeMode(mode)];
}

function getActiveInstructions() {
  return state.defaultInstructionsByMode[normalizeMode(state.currentMode)] || '';
}

function buildHistoryScope() {
  if (!state.profileId) {
    return 'no-profile';
  }

  if (state.accessMode === 'public') {
    return `profile:${state.profileId}:public`;
  }

  if (state.relayApiKey) {
    return `profile:${state.profileId}:own:${simpleHash(state.relayApiKey)}`;
  }

  return `profile:${state.profileId}:own:empty`;
}

async function refreshHistoryForCurrentScope(options = {}) {
  const { resetConversation = false } = options;

  state.historyScope = buildHistoryScope();
  state.history = await loadConversations();

  if (resetConversation) {
    createBlankConversation();
    return;
  }

  restoreCurrentConversation();
}

function normalizeInstructionsByMode(config) {
  const input =
    config && config.defaultInstructionsByMode && typeof config.defaultInstructionsByMode === 'object'
      ? config.defaultInstructionsByMode
      : {};

  return {
    chat: typeof input.chat === 'string' ? input.chat : config?.defaultInstructions || '',
    prompt_optimizer:
      typeof input.prompt_optimizer === 'string' ? input.prompt_optimizer : '',
  };
}

function normalizeRelayAccessMode(value) {
  return value === 'public' ? 'public' : 'own';
}

function syncRelayAccessState() {
  if (state.accessMode === 'public') {
    state.hasApiKey = state.hasPublicRelayKey;
    return;
  }

  state.hasApiKey = Boolean(state.relayApiKey);
}

function buildRelayAccessInfoText() {
  if (state.accessMode === 'public') {
    return state.hasPublicRelayKey
      ? '当前使用公益 key。聊天记录只在这个浏览器里保存，不会和其他浏览器共享。'
      : '当前选中了公益 key，但服务端没有可用的默认 key，所以暂时不能使用。';
  }

  return state.hasApiKey
    ? '已保存到当前浏览器，可直接开始使用；聊天记录只在这个浏览器里按当前 key 隔离。'
    : '先在当前浏览器保存 RELAY_API_KEY，保存后才可以使用。';
}

function matchesCurrentHistoryScope(conversation, scope) {
  if (conversation.historyScope === scope) {
    return true;
  }

  if (state.accessMode === 'own' && state.relayApiKey) {
    return conversation.historyScope === `relay:${simpleHash(state.relayApiKey)}`;
  }

  return false;
}

function normalizeConversationRecord(record) {
  return {
    ...record,
    historyScope: typeof record?.historyScope === 'string' ? record.historyScope : '',
    mode: normalizeMode(record?.mode),
    messages: Array.isArray(record?.messages) ? record.messages : [],
  };
}
