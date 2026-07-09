/* global io, marked, DOMPurify */
(() => {
  const $ = (id) => document.getElementById(id);
  const threadEl = $('thread');
  const messagesEl = $('messages');
  const heroEl = $('hero');
  const convListEl = $('conv-list');
  const inputEl = $('input');
  const sendBtn = $('send-btn');
  const stopBtn = $('stop-btn');
  const sidebar = $('sidebar');

  marked.setOptions({ breaks: true, gfm: true });
  const render = (md) => DOMPurify.sanitize(marked.parse(md));

  // stable anonymous identity so conversations survive reloads
  let uid = localStorage.getItem('chatbot:uid');
  if (!uid) {
    uid = crypto.randomUUID();
    localStorage.setItem('chatbot:uid', uid);
  }

  const state = {
    conversations: [],
    activeId: null,
    streamEl: null, // content element currently being streamed into
    streamBuf: '',
    generating: false,
  };

  const socket = io({ auth: { uid } });

  /* ================= connection ================= */
  socket.on('connect', () => {
    $('conn-dot').classList.add('on');
    $('conn-text').textContent = 'connected';
    refreshConversations().then(() => {
      // re-open active conversation after reconnect (may be a new instance)
      if (state.activeId) openConversation(state.activeId, { keepThread: true });
    });
  });
  socket.on('disconnect', () => {
    $('conn-dot').classList.remove('on');
    $('conn-text').textContent = 'reconnecting…';
  });
  socket.on('ready', ({ instance, botMode, model }) => {
    $('instance-name').textContent = instance;
    $('mode-text').textContent = botMode === 'claude' ? `model ${model}` : 'offline demo mode';
    $('offline-note').hidden = botMode !== 'local';
    if (botMode === 'local') {
      $('hero-sub').textContent =
        'Running in offline demo mode — replies are simple, but streaming, history and scaling are all real.';
    }
  });

  /* ================= conversations ================= */
  const emit = (event, payload) =>
    new Promise((resolve) => (payload === undefined ? socket.emit(event, resolve) : socket.emit(event, payload, resolve)));

  async function refreshConversations() {
    const res = await emit('conversations');
    if (res?.ok) {
      state.conversations = res.conversations;
      renderConvList();
    }
  }

  function renderConvList() {
    convListEl.innerHTML = '';
    for (const c of state.conversations) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'conv-item' + (c.id === state.activeId ? ' active' : '');
      item.dataset.id = c.id;

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = c.title;

      const del = document.createElement('span');
      del.className = 'del';
      del.title = 'Delete chat';
      del.textContent = '🗑';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await emit('conversation:delete', { id: c.id });
        state.conversations = state.conversations.filter((x) => x.id !== c.id);
        if (state.activeId === c.id) {
          state.activeId = null;
          showHero();
        }
        renderConvList();
      });

      item.append(title, del);
      item.addEventListener('click', () => openConversation(c.id));
      convListEl.appendChild(item);
    }
  }

  // "New chat" just shows the hero — the conversation itself is created
  // lazily by send(), so abandoned chats never clutter the sidebar
  function newConversation() {
    state.activeId = null;
    endStream();
    setGenerating(false);
    showHero();
    renderConvList();
    if (window.innerWidth <= 720) sidebar.classList.add('collapsed');
    inputEl.focus();
  }

  async function openConversation(id, { keepThread = false } = {}) {
    const res = await emit('conversation:open', { id });
    if (!res?.ok) {
      // conversation vanished (deleted elsewhere) — refresh the list
      await refreshConversations();
      return;
    }
    state.activeId = id;
    $('topbar-title').textContent = res.conversation.title === 'New chat' ? '' : res.conversation.title;
    renderConvList();
    if (keepThread && state.generating) return; // don't clobber an in-progress stream

    messagesEl.innerHTML = '';
    endStream();
    if (res.messages.length === 0) {
      showHero();
    } else {
      hideHero();
      for (const m of res.messages) addMessage(m);
      scrollToBottom(true);
    }
    if (window.innerWidth <= 720) sidebar.classList.add('collapsed');
  }

  socket.on('conversation:created', ({ conversation }) => {
    if (!state.conversations.some((c) => c.id === conversation.id)) {
      state.conversations.unshift(conversation);
      renderConvList();
    }
  });

  socket.on('conversation:updated', ({ conversation }) => {
    const c = state.conversations.find((x) => x.id === conversation.id);
    if (c) Object.assign(c, conversation);
    else state.conversations.unshift(conversation);
    state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    renderConvList();
    if (conversation.id === state.activeId) $('topbar-title').textContent = conversation.title;
  });

  socket.on('conversation:deleted', ({ id }) => {
    state.conversations = state.conversations.filter((x) => x.id !== id);
    if (state.activeId === id) {
      state.activeId = null;
      showHero();
    }
    renderConvList();
  });

  /* ================= messages ================= */
  function addMessage(m) {
    hideHero();
    const row = document.createElement('div');
    row.className = `row ${m.role}`;
    row.dataset.id = m.id;

    const content = document.createElement('div');
    content.className = 'content';

    if (m.role === 'assistant') {
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = '✦';
      content.innerHTML = render(m.content);

      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const copy = document.createElement('button');
      copy.className = 'copy-btn';
      copy.textContent = '⧉ copy';
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(m.content);
        copy.textContent = '✓ copied';
        setTimeout(() => (copy.textContent = '⧉ copy'), 1200);
      });
      actions.appendChild(copy);

      const inner = document.createElement('div');
      inner.style.minWidth = '0';
      inner.append(content, actions);
      row.append(avatar, inner);
    } else {
      content.textContent = m.content;
      row.appendChild(content);
    }

    messagesEl.appendChild(row);
    return content;
  }

  /* ---- streaming assistant reply ---- */
  socket.on('message:new', ({ conversationId, message }) => {
    if (conversationId !== state.activeId) return;
    if (messagesEl.querySelector(`[data-id="${message.id}"]`)) return;
    addMessage(message);
    scrollToBottom(message.role === 'user');
  });

  socket.on('assistant:start', ({ conversationId, id }) => {
    if (conversationId !== state.activeId) return;
    hideHero();
    setGenerating(true);
    const row = document.createElement('div');
    row.className = 'row assistant';
    row.dataset.id = id;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = '✦';
    const content = document.createElement('div');
    content.className = 'content streaming';
    const inner = document.createElement('div');
    inner.style.minWidth = '0';
    inner.appendChild(content);
    row.append(avatar, inner);
    messagesEl.appendChild(row);
    state.streamEl = content;
    state.streamBuf = '';
    scrollToBottom();
  });

  let rafPending = false;
  socket.on('assistant:delta', ({ conversationId, delta }) => {
    if (conversationId !== state.activeId || !state.streamEl) return;
    state.streamBuf += delta;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (state.streamEl) {
          state.streamEl.innerHTML = render(state.streamBuf);
          scrollToBottom();
        }
      });
    }
  });

  socket.on('assistant:done', ({ conversationId, message }) => {
    if (conversationId !== state.activeId) return;
    // replace the streaming row with the final rendered message
    const row = messagesEl.querySelector(`[data-id="${message.id}"]`);
    if (row) row.remove();
    endStream();
    addMessage(message);
    setGenerating(false);
    scrollToBottom();
    refreshConversations();
  });

  socket.on('assistant:error', ({ conversationId, id, error }) => {
    if (conversationId !== state.activeId) return;
    const row = messagesEl.querySelector(`[data-id="${id}"]`);
    if (row) row.remove();
    endStream();
    setGenerating(false);
    const errRow = document.createElement('div');
    errRow.className = 'row assistant error';
    errRow.innerHTML = `<div class="avatar">✦</div><div class="content">⚠ ${error}</div>`;
    messagesEl.appendChild(errRow);
    scrollToBottom();
  });

  function endStream() {
    if (state.streamEl) state.streamEl.classList.remove('streaming');
    state.streamEl = null;
    state.streamBuf = '';
  }

  function setGenerating(on) {
    state.generating = on;
    stopBtn.hidden = !on;
    updateSendBtn();
  }

  /* ================= composer ================= */
  async function send() {
    const text = inputEl.value.trim();
    if (!text || state.generating) return;

    // lazily create a conversation on first message
    if (!state.activeId) {
      const res = await emit('conversation:new');
      if (!res?.ok) return toast(res?.error);
      state.conversations.unshift(res.conversation);
      const open = await emit('conversation:open', { id: res.conversation.id });
      if (!open?.ok) return toast(open?.error);
      state.activeId = res.conversation.id;
      renderConvList();
    }

    inputEl.value = '';
    autosize();
    updateSendBtn();
    hideHero();

    // the echoed message:new event renders the message (same socket, ~instant)
    const res = await emit('message:send', { conversationId: state.activeId, text });
    if (!res?.ok) {
      inputEl.value = text;
      autosize();
      updateSendBtn();
      return toast(res?.error);
    }
  }

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener('input', () => {
    autosize();
    updateSendBtn();
  });
  stopBtn.addEventListener('click', () => {
    socket.emit('assistant:stop', { conversationId: state.activeId });
  });

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 200)}px`;
  }
  function updateSendBtn() {
    sendBtn.disabled = !inputEl.value.trim() || state.generating;
  }

  /* ================= misc UI ================= */
  $('new-chat').addEventListener('click', newConversation);
  $('collapse-btn').addEventListener('click', () => sidebar.classList.add('collapsed'));
  $('open-sidebar').addEventListener('click', () => sidebar.classList.remove('collapsed'));

  document.querySelectorAll('.suggestion').forEach((btn) =>
    btn.addEventListener('click', () => {
      inputEl.value = btn.dataset.text;
      autosize();
      updateSendBtn();
      send();
    }),
  );

  function showHero() {
    heroEl.style.display = '';
    messagesEl.innerHTML = '';
    $('topbar-title').textContent = '';
  }
  function hideHero() {
    heroEl.style.display = 'none';
  }

  function scrollToBottom(force = false) {
    const nearBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 140;
    if (force || nearBottom) threadEl.scrollTop = threadEl.scrollHeight;
  }

  let toastTimer = null;
  function toast(text) {
    document.querySelector('.toast')?.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text ?? 'Something went wrong.';
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3500);
  }

  // start collapsed on mobile
  if (window.innerWidth <= 720) sidebar.classList.add('collapsed');
  updateSendBtn();
})();
