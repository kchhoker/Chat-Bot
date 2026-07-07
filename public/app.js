/* global io */
(() => {
  const $ = (id) => document.getElementById(id);

  const joinScreen = $('join-screen');
  const chatScreen = $('chat-screen');
  const joinForm = $('join-form');
  const joinError = $('join-error');
  const messagesEl = $('messages');
  const typingEl = $('typing');
  const messageForm = $('message-form');
  const messageInput = $('message-input');
  const switchForm = $('switch-form');
  const switchRoom = $('switch-room');

  const state = {
    username: null,
    room: null,
    botName: 'ChatBot',
    typers: new Set(),
    streams: new Map(), // bot stream id -> bubble element
  };

  const socket = io({ autoConnect: true });

  // ---------- connection status ----------
  socket.on('connect', () => {
    $('conn-dot').classList.add('on');
    $('conn-text').textContent = 'connected';
    // reconnects land on a (possibly different) instance — rejoin the room
    if (state.username && state.room) join(state.username, state.room);
  });
  socket.on('disconnect', () => {
    $('conn-dot').classList.remove('on');
    $('conn-text').textContent = 'reconnecting…';
  });

  // ---------- join / switch rooms ----------
  function join(username, room) {
    socket.emit('join', { username, room }, (res) => {
      if (!res?.ok) {
        joinError.textContent = res?.error ?? 'Could not join.';
        joinError.hidden = false;
        return;
      }
      state.username = res.username;
      state.room = res.room;
      state.botName = res.botName;
      joinScreen.hidden = true;
      chatScreen.hidden = false;
      $('room-name').textContent = `# ${res.room}`;
      $('instance-name').textContent = res.instance;
      $('bot-mode').textContent = res.botMode === 'claude' ? 'Claude AI' : 'local (offline)';
      messagesEl.innerHTML = '';
      state.typers.clear();
      renderTyping();
      for (const m of res.messages) addMessage(m);
      messageInput.focus();
    });
  }

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    joinError.hidden = true;
    join($('username').value.trim(), $('room').value.trim() || 'general');
  });

  switchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const room = switchRoom.value.trim();
    if (room) {
      join(state.username, room);
      switchRoom.value = '';
    }
  });

  // ---------- sending ----------
  messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;
    socket.emit('message', { text }, (res) => {
      if (!res?.ok) flashSystem(res?.error ?? 'Message failed to send.');
    });
    messageInput.value = '';
    sendTyping(false);
  });

  let typingTimer = null;
  let typingSent = false;
  function sendTyping(isTyping) {
    if (typingSent !== isTyping) {
      socket.emit('typing', isTyping);
      typingSent = isTyping;
    }
  }
  messageInput.addEventListener('input', () => {
    sendTyping(messageInput.value.length > 0);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => sendTyping(false), 2500);
  });

  // ---------- receiving ----------
  socket.on('message', (m) => {
    if (m.room !== state.room) return;
    // bot message finalizes any live stream bubble with the same id
    const streaming = state.streams.get(m.id);
    if (streaming) {
      streaming.remove();
      state.streams.delete(m.id);
    }
    addMessage(m);
  });

  socket.on('presence', ({ room, users }) => {
    if (room !== state.room) return;
    $('user-count').textContent = `(${users.length})`;
    $('user-list').innerHTML = '';
    for (const u of users) {
      const li = document.createElement('li');
      li.textContent = u;
      $('user-list').appendChild(li);
    }
  });

  socket.on('typing', ({ username, isTyping }) => {
    if (username === state.username) return;
    if (isTyping) state.typers.add(username);
    else state.typers.delete(username);
    renderTyping();
  });

  // live-streamed bot reply
  socket.on('bot-stream', ({ id, room, phase, chunk }) => {
    if (room !== state.room) return;
    if (phase === 'start') {
      const el = buildMessage({ username: state.botName, text: '', ts: Date.now(), bot: true });
      state.streams.set(id, el);
      appendAndScroll(el);
    } else if (phase === 'chunk') {
      const el = state.streams.get(id);
      if (el) {
        el.querySelector('.bubble').textContent += chunk;
        scrollDown();
      }
    }
    // 'end' is handled by the final 'message' event replacing the bubble
  });

  // ---------- rendering ----------
  function buildMessage(m) {
    const el = document.createElement('div');
    if (m.system) {
      el.className = 'msg system';
      el.textContent = m.text;
      return el;
    }
    el.className = 'msg';
    if (m.bot) el.classList.add('bot');
    if (m.username === state.username) el.classList.add('me');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = m.username;
    const time = document.createElement('span');
    time.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.append(author, time);
    if (m.instance) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.title = 'server instance that handled this message';
      badge.textContent = m.instance;
      meta.append(badge);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = m.text;

    el.append(meta, bubble);
    return el;
  }

  function addMessage(m) {
    appendAndScroll(buildMessage(m));
  }

  function flashSystem(text) {
    addMessage({ system: true, text });
  }

  function appendAndScroll(el) {
    const nearBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    messagesEl.appendChild(el);
    if (nearBottom) scrollDown();
  }

  function scrollDown() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderTyping() {
    const names = [...state.typers];
    typingEl.textContent =
      names.length === 0
        ? ''
        : names.length === 1
          ? `${names[0]} is typing…`
          : `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` and ${names.length - 2} more` : ''} are typing…`;
  }
})();
