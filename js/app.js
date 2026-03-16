(async function () {
  let songs = [];
  let sortKey = 'title';
  let sortAsc = true;
  let currentCard = null;
  let currentAudio = null;

  function updateSortButtons() {
    document.querySelectorAll('.sort-btn').forEach(btn => {
      const key = btn.dataset.sort;
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      const isActive = key === sortKey;
      btn.classList.toggle('active', isActive);
      btn.textContent = isActive ? label + (sortAsc ? ' \u25b2' : ' \u25bc') : label;
    });
  }

  async function loadSongs() {
    const res = await fetch('songs.json');
    if (!res.ok) throw new Error('Could not load songs.json');
    songs = await res.json();
  }

  function formatDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });
  }

  function stopCurrent() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    }
    if (currentCard) {
      const btn = currentCard.querySelector('.play-pause-btn');
      const prog = currentCard.querySelector('.progress-input');
      if (btn) { btn.textContent = '\u25B6'; btn.setAttribute('aria-label', 'Play'); }
      if (prog) prog.value = 0;
      currentCard.classList.remove('open', 'playing');
    }
    currentCard = null;
    currentAudio = null;
  }

  function togglePlay(card, audioEl, playBtn, progressInput) {
    if (!card.classList.contains('open')) {
      // Open card and start playing, stopping any other card first
      if (currentCard && currentCard !== card) stopCurrent();
      card.classList.add('open', 'playing');
      currentCard = card;
      currentAudio = audioEl;
      audioEl.play().catch(() => {});
      playBtn.textContent = '\u23F8';
      playBtn.setAttribute('aria-label', 'Pause');
    } else if (audioEl.paused) {
      // Card is open but paused: resume
      audioEl.play().catch(() => {});
      playBtn.textContent = '\u23F8';
      playBtn.setAttribute('aria-label', 'Pause');
      card.classList.add('playing');
      currentCard = card;
      currentAudio = audioEl;
    } else {
      // Card is open and playing: pause
      audioEl.pause();
      playBtn.textContent = '\u25B6';
      playBtn.setAttribute('aria-label', 'Play');
      card.classList.remove('playing');
    }
  }

  function buildCard(song) {
    const card = document.createElement('div');
    card.className = 'song-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', song.title);

    // Build safe file paths
    const encodedFilename = song.filename.split('/').map(encodeURIComponent).join('/');
    const mp3Filename = song.filename.replace(/\.m4a$/i, '.mp3');
    const encodedMp3 = mp3Filename.split('/').map(encodeURIComponent).join('/');
    const m4aPath = 'music/' + encodedFilename;
    const mp3Path = 'music/mp3/' + encodedMp3;

    // Hidden audio element (no native controls = no "more options" button)
    const audioEl = document.createElement('audio');
    audioEl.preload = 'none';
    const source = document.createElement('source');
    source.src = m4aPath;
    source.type = 'audio/mp4';
    audioEl.appendChild(source);
    card.appendChild(audioEl);

    // ── TOP: Player controls ──
    const controls = document.createElement('div');
    controls.className = 'song-controls';

    const playBtn = document.createElement('button');
    playBtn.className = 'play-pause-btn';
    playBtn.setAttribute('aria-label', 'Play');
    playBtn.textContent = '\u25B6';

    const progressWrap = document.createElement('div');
    progressWrap.className = 'progress-wrap';

    const progressInput = document.createElement('input');
    progressInput.type = 'range';
    progressInput.className = 'progress-input';
    progressInput.min = '0';
    progressInput.max = '100';
    progressInput.value = '0';
    progressInput.step = '0.1';
    progressInput.setAttribute('aria-label', 'Playback position');

    progressWrap.appendChild(progressInput);
    controls.appendChild(playBtn);
    controls.appendChild(progressWrap);
    card.appendChild(controls);

    // ── CENTER: Title ──
    const titleSpan = document.createElement('span');
    titleSpan.className = 'song-title';
    titleSpan.textContent = song.title;
    card.appendChild(titleSpan);

    // ── BOTTOM: Downloads ──
    const dlLinks = document.createElement('div');
    dlLinks.className = 'song-downloads';

    const m4aLink = document.createElement('a');
    m4aLink.className = 'download-btn';
    m4aLink.href = m4aPath;
    m4aLink.download = '';
    m4aLink.textContent = '\u2193 Download M4A';

    const mp3Link = document.createElement('a');
    mp3Link.className = 'download-btn mp3';
    mp3Link.href = mp3Path;
    mp3Link.download = '';
    mp3Link.textContent = '\u2193 Download MP3';

    dlLinks.appendChild(m4aLink);
    dlLinks.appendChild(mp3Link);
    card.appendChild(dlLinks);

    // ── BOTTOM-LEFT: Date ──
    const dateSpan = document.createElement('span');
    dateSpan.className = 'song-date';
    dateSpan.textContent = formatDate(song.date);
    card.appendChild(dateSpan);

    // ── Interactions ──

    // Clicking the card background/title toggles play
    card.addEventListener('click', (e) => {
      if (e.target.closest('a, .play-pause-btn, .progress-input')) return;
      togglePlay(card, audioEl, playBtn, progressInput);
    });

    // Keyboard: Enter or Space activates play
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        togglePlay(card, audioEl, playBtn, progressInput);
      }
    });

    // Dedicated play/pause button
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlay(card, audioEl, playBtn, progressInput);
    });

    // Seek via progress bar
    progressInput.addEventListener('input', (e) => {
      e.stopPropagation();
      if (audioEl.duration) {
        audioEl.currentTime = (progressInput.value / 100) * audioEl.duration;
      }
    });

    // Prevent download clicks from toggling play
    [m4aLink, mp3Link].forEach(link => {
      link.addEventListener('click', e => e.stopPropagation());
    });

    // Sync progress bar with playback
    audioEl.addEventListener('timeupdate', () => {
      if (audioEl.duration) {
        progressInput.value = (audioEl.currentTime / audioEl.duration) * 100;
      }
    });

    // Reset on song end
    audioEl.addEventListener('ended', () => {
      playBtn.textContent = '\u25B6';
      playBtn.setAttribute('aria-label', 'Play');
      progressInput.value = 0;
      card.classList.remove('playing');
    });

    return card;
  }

  function renderSongs() {
    const container = document.getElementById('song-list');
    container.innerHTML = '';
    currentCard = null;
    currentAudio = null;

    const sorted = [...songs].sort((a, b) => {
      const va = (a[sortKey] || '').toLowerCase();
      const vb = (b[sortKey] || '').toLowerCase();
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });

    sorted.forEach(song => container.appendChild(buildCard(song)));
  }

  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sort;
      if (sortKey === key) {
        sortAsc = !sortAsc;
      } else {
        sortKey = key;
        sortAsc = true;
      }
      updateSortButtons();
      renderSongs();
    });
  });

  try {
    await loadSongs();
    updateSortButtons();
    renderSongs();
  } catch (err) {
    console.error('Failed to load songs:', err);
    document.getElementById('song-list').innerHTML =
      '<p style="color:#555;text-align:center;padding:40px">Could not load song list. Make sure you\'re running this through a web server, not directly from the file system.</p>';
  }
})();
