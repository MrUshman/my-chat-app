'use strict';

/**
 * emoji.js — Lightweight emoji picker
 * No external library. Uses a curated set of Unicode emojis.
 */

const EMOJI_CATEGORIES = [
  {
    name: 'Smileys',
    icon: '😊',
    emojis: [
      '😀','😃','😄','😁','😆','🥹','😅','😂','🤣','☺️','😊','😇',
      '🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛',
      '😝','😜','🤪','🤨','🧐','🤓','😎','🥸','🤩','🥳','😏','😒',
      '😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢',
      '😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰',
      '😥','😓','🤗','🤔','🫣','🤭','🫡','🤫','🤥','😶','😐','😑',
      '😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵',
    ],
  },
  {
    name: 'Hearts',
    icon: '❤️',
    emojis: [
      '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹',
      '💕','💞','💓','💗','💖','💘','💝','💟','♥️','🫀','💌','💋',
      '🫦','😍','🥰','😘','🫶','🤗','🫂','💑','👫','👬','👭',
    ],
  },
  {
    name: 'Gestures',
    icon: '👋',
    emojis: [
      '👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏',
      '✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️',
      '🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲',
      '🤝','🙏','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🫀','🧠',
    ],
  },
  {
    name: 'People',
    icon: '👩',
    emojis: [
      '👶','🧒','👦','👧','🧑','👱','👨','🧔','👩','🧓','👴','👵',
      '🙍','🙎','🙅','🙆','💁','🙋','🧏','🙇','🤦','🤷','👮','🕵️',
      '💂','🧑‍⚕️','👨‍⚕️','👩‍⚕️','🧑‍🎓','💑','👫','🫂','🧑‍🤝‍🧑',
    ],
  },
  {
    name: 'Nature',
    icon: '🌸',
    emojis: [
      '🌸','🌺','🌻','🌹','🥀','🌷','💐','🌼','🌿','🍀','☘️','🍁',
      '🍂','🍃','🌱','🌲','🌳','🌴','🎋','🎍','🐶','🐱','🐭','🐹',
      '🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔',
      '🐧','🐦','🦆','🦅','🦉','🦋','🐛','🐝','🌙','⭐','🌟','💫',
    ],
  },
  {
    name: 'Food',
    icon: '🍕',
    emojis: [
      '🍕','🍔','🍟','🌭','🌮','🌯','🥙','🧆','🥚','🍳','🥘','🍲',
      '🥗','🥣','🥫','🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍠','🍢',
      '🍣','🍤','🍥','🥮','🍡','🧁','🎂','🍰','🍫','🍬','🍭','🍮',
      '🍯','🍦','🍧','🍨','🍩','🍪','☕','🧋','🍵','🥤','🍹','🍷',
    ],
  },
  {
    name: 'Symbols',
    icon: '✨',
    emojis: [
      '✨','💥','🔥','🌈','🎉','🎊','🎈','🎀','🎁','🏆','🥇','⭐',
      '🌟','💫','⚡','🌙','☀️','🌤️','⛅','🌦️','🌧️','🌨️','❄️','💧',
      '💦','🌊','🎵','🎶','🎸','🎹','🎺','🎻','🥁','🎤','🎧','📱',
      '💻','📷','📸','📹','🎥','📞','☎️','📝','✏️','🖊️','📚','🔑',
    ],
  },
];

// DOM references
const emojiBtn = document.getElementById('emojiBtn');
const emojiPicker = document.getElementById('emojiPicker');
const emojiTabs = document.getElementById('emojiTabs');
const emojiGrid = document.getElementById('emojiGrid');
const emojiSearch = document.getElementById('emojiSearch');
// Note: messageInput is declared in chat.js — we use getElementById() inline here

let currentCategory = 0;
let isOpen = false;

// Build tab buttons
function buildTabs() {
  emojiTabs.innerHTML = '';
  EMOJI_CATEGORIES.forEach((cat, i) => {
    const tab = document.createElement('button');
    tab.className = `emoji-tab${i === currentCategory ? ' active' : ''}`;
    tab.textContent = cat.icon;
    tab.title = cat.name;
    tab.addEventListener('click', () => {
      currentCategory = i;
      buildTabs();
      renderEmojis(EMOJI_CATEGORIES[i].emojis);
    });
    emojiTabs.appendChild(tab);
  });
}

// Render emoji buttons
function renderEmojis(emojis) {
  emojiGrid.innerHTML = '';
  emojis.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn';
    btn.textContent = emoji;
    btn.title = emoji;
    btn.addEventListener('click', () => insertEmoji(emoji));
    emojiGrid.appendChild(btn);
  });
}

// Insert emoji into message input
function insertEmoji(emoji) {
  const msgInput = document.getElementById('messageInput');
  if (!msgInput) return;
  const start = msgInput.selectionStart;
  const end = msgInput.selectionEnd;
  const value = msgInput.value;
  msgInput.value = value.slice(0, start) + emoji + value.slice(end);
  msgInput.selectionStart = msgInput.selectionEnd = start + emoji.length;
  msgInput.focus();

  // Trigger input event to update send button state
  msgInput.dispatchEvent(new Event('input'));
}

// Search emojis across all categories
emojiSearch.addEventListener('input', () => {
  const query = emojiSearch.value.trim().toLowerCase();
  if (!query) {
    renderEmojis(EMOJI_CATEGORIES[currentCategory].emojis);
    return;
  }
  // Simple search — find emojis where the unicode name matches (we use label search)
  const allEmojis = EMOJI_CATEGORIES.flatMap(c => c.emojis);
  // Since we don't have names, show all emojis when searching (user can browse)
  renderEmojis(allEmojis);
});

// Toggle picker
function openPicker() {
  isOpen = true;
  emojiPicker.classList.add('open');
  emojiBtn.classList.add('active');
  buildTabs();
  renderEmojis(EMOJI_CATEGORIES[currentCategory].emojis);
  emojiSearch.value = '';
}

function closePicker() {
  isOpen = false;
  emojiPicker.classList.remove('open');
  emojiBtn.classList.remove('active');
}

emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  isOpen ? closePicker() : openPicker();
});

// Close on outside click
document.addEventListener('click', (e) => {
  if (isOpen && !emojiPicker.contains(e.target) && e.target !== emojiBtn) {
    closePicker();
  }
});

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isOpen) closePicker();
});

window.EmojiPicker = { open: openPicker, close: closePicker };
