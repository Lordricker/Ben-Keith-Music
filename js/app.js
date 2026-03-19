(async function () {
  let songs = [];
  let sortKey = 'title';
  let sortAsc = true;
  let activeCategories = new Set(['all']);
  let currentCard = null;
  let currentAudio = null;
  let favorites = new Set(JSON.parse(localStorage.getItem('bk-favorites') || '[]'));
  const silenceCache = new Map(); // src -> seconds to skip
  // Single shared <audio> element — stays trusted by the browser after the first
  // user gesture, so chained autoplay works indefinitely without new gestures.
  const playerAudio = new Audio();

  // ── Silent audio keepalive (prevents iOS from suspending JS between songs) ──
  let _silentAudio = null;
  let _silentUrl = null;
  let _silentStopTimer = null;
  const SILENT_IDLE_TIMEOUT = 7 * 60 * 1000; // stop after 7 min of no playback

  function _createSilentBlob() {
    // Generate a 1-second silent mono WAV at 8000 Hz entirely in JS (no file needed)
    const sr = 8000, samples = sr;
    const buf = new ArrayBuffer(44 + samples * 2);
    const v = new DataView(buf);
    const txt = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    txt(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true);
    txt(8, 'WAVE'); txt(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    txt(36, 'data'); v.setUint32(40, samples * 2, true);
    // samples stay zero = silence
    return new Blob([buf], { type: 'audio/wav' });
  }

  function startSilentAudio() {
    clearTimeout(_silentStopTimer);
    if (!_silentAudio) {
      _silentUrl = URL.createObjectURL(_createSilentBlob());
      _silentAudio = new Audio(_silentUrl);
      _silentAudio.loop = true;
      _silentAudio.volume = 0;
    }
    if (_silentAudio.paused) _silentAudio.play().catch(() => {});
  }

  function scheduleSilentAudioStop() {
    clearTimeout(_silentStopTimer);
    _silentStopTimer = setTimeout(() => {
      if (_silentAudio) _silentAudio.pause();
    }, SILENT_IDLE_TIMEOUT);
  }

  function saveFavorites() {
    localStorage.setItem('bk-favorites', JSON.stringify([...favorites]));
  }

  function updateSortButtons() {
    document.querySelectorAll('[data-sort]').forEach(btn => {
      const key = btn.dataset.sort;
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      const isActive = key === sortKey;
      btn.classList.toggle('active', isActive);
      btn.textContent = isActive ? label + (sortAsc ? ' ▲' : ' ▼') : label;
    });
  }

  function updateCategoryButtons() {
    document.querySelectorAll('[data-cat]').forEach(btn => {
      btn.classList.toggle('active', activeCategories.has(btn.dataset.cat));
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

  function parseCategories(filename) {
    const match = filename.match(/\s*-\s*([A-Za-z]+)\.[^.]+$/);
    if (!match) return [];
    return match[1].toUpperCase().split('');
  }

  function stopCurrent() {
    playerAudio.pause();
    playerAudio.currentTime = 0;
    if (currentCard) {
      const btn = currentCard.querySelector('.play-pause-btn');
      const prog = currentCard.querySelector('.progress-input');
      if (btn) btn.textContent = '\u25B6';
      if (prog) prog.value = 0;
      currentCard.classList.remove('open', 'playing');
    }
    currentCard = null;
    currentAudio = null;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    scheduleSilentAudioStop();
  }

  function updateMediaSession(song) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: 'Ben Keith',
      album: 'Ben Keith Music',
      artwork: [
        { src: 'background.jpg', sizes: '512x512', type: 'image/jpeg' }
      ]
    });

    navigator.mediaSession.setActionHandler('play', () => {
      if (currentAudio) currentAudio.play().catch(() => {});
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      if (currentCard) {
        const btn = currentCard.querySelector('.play-pause-btn');
        if (btn) btn.textContent = '\u23F8';
        currentCard.classList.add('playing');
      }
    });

    navigator.mediaSession.setActionHandler('pause', () => {
      if (currentAudio) currentAudio.pause();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      if (currentCard) {
        const btn = currentCard.querySelector('.play-pause-btn');
        if (btn) btn.textContent = '\u25B6';
        currentCard.classList.remove('playing');
      }
    });

    navigator.mediaSession.setActionHandler('nexttrack', () => {
      if (!currentCard) return;
      const cards = Array.from(document.querySelectorAll('.song-card'));
      const idx = cards.indexOf(currentCard);
      if (idx !== -1 && idx + 1 < cards.length) {
        stopCurrent();
        cards[idx + 1].click();
      }
    });

    navigator.mediaSession.setActionHandler('previoustrack', () => {
      if (!currentCard) return;
      const cards = Array.from(document.querySelectorAll('.song-card'));
      const idx = cards.indexOf(currentCard);
      if (idx > 0) {
        stopCurrent();
        cards[idx - 1].click();
      } else if (currentAudio) {
        // At first song — restart it
        currentAudio.currentTime = 0;
      }
    });
  }

  // Fetch + decode audio, find first non-silent sample.
  // Returns seconds to skip (0 if silence < minSilence).
  async function findSkipTime(src, minSilence = 1.0, threshold = 0.01) {
    if (!src) return 0;
    if (silenceCache.has(src)) return silenceCache.get(src);
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error('fetch failed');
      const arrayBuffer = await response.arrayBuffer();
      const audioCtx = new AudioContext();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      audioCtx.close();
      const sampleRate = audioBuffer.sampleRate;
      const numChannels = audioBuffer.numberOfChannels;
      // Only scan the first 10 seconds
      const maxScan = Math.min(audioBuffer.length, Math.ceil(sampleRate * 10));
      const minSamples = Math.floor(minSilence * sampleRate);
      const channelData = Array.from({ length: numChannels }, (_, c) => audioBuffer.getChannelData(c));
      let firstNonSilent = -1;
      for (let i = 0; i < maxScan && firstNonSilent === -1; i++) {
        for (let c = 0; c < numChannels; c++) {
          if (Math.abs(channelData[c][i]) > threshold) { firstNonSilent = i; break; }
        }
      }
      const skipTime = firstNonSilent > minSamples
        ? Math.max(0, firstNonSilent / sampleRate - 0.05)
        : 0;
      silenceCache.set(src, skipTime);
      return skipTime;
    } catch {
      silenceCache.set(src, 0);
      return 0;
    }
  }

  function togglePlay(card, playBtn, progressInput, song, m4aSrc) {
    if (!card.classList.contains('open')) {
      // Open card and start playing, stopping any other card first
      if (currentCard && currentCard !== card) stopCurrent();
      card.classList.add('open', 'playing');
      currentCard = card;
      currentAudio = playerAudio;
      playerAudio.src = m4aSrc;
      playerAudio.play().catch(() => {});
      startSilentAudio();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      playBtn.textContent = '\u23F8';
      updateMediaSession(song);
      findSkipTime(m4aSrc).then(t => {
        if (t > 0 && currentCard === card && playerAudio.currentTime < t + 0.5)
          playerAudio.currentTime = t;
      });
    } else if (playerAudio.paused) {
      // Card is open but paused: resume
      playerAudio.play().catch(() => {});
      startSilentAudio();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      playBtn.textContent = '\u23F8';
      card.classList.add('playing');
      currentCard = card;
      currentAudio = playerAudio;
      updateMediaSession(song);
    } else {
      // Card is open and playing: pause
      playerAudio.pause();
      scheduleSilentAudioStop();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      playBtn.textContent = '\u25B6';
      card.classList.remove('playing');
    }
  }

  function floatTo16BitPCM(float32Array) {
    const out = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  async function convertAndDownloadMp3(m4aPath, outFilename, btn) {
    const original = btn.textContent;
    btn.textContent = 'Converting…';
    btn.disabled = true;
    try {
      const response = await fetch(m4aPath);
      if (!response.ok) throw new Error('Could not fetch audio file');
      const arrayBuffer = await response.arrayBuffer();

      const audioCtx = new AudioContext();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      audioCtx.close();

      const channels = audioBuffer.numberOfChannels > 1 ? 2 : 1;
      const sampleRate = audioBuffer.sampleRate;
      const encoder = new lamejs.Mp3Encoder(channels, sampleRate, 128);
      const blockSize = 1152;
      const mp3Data = [];

      if (channels === 1) {
        const pcm = floatTo16BitPCM(audioBuffer.getChannelData(0));
        for (let i = 0; i < pcm.length; i += blockSize) {
          const buf = encoder.encodeBuffer(pcm.subarray(i, i + blockSize));
          if (buf.length > 0) mp3Data.push(buf);
        }
      } else {
        const leftPcm = floatTo16BitPCM(audioBuffer.getChannelData(0));
        const rightPcm = floatTo16BitPCM(audioBuffer.getChannelData(1));
        for (let i = 0; i < leftPcm.length; i += blockSize) {
          const buf = encoder.encodeBuffer(
            leftPcm.subarray(i, i + blockSize),
            rightPcm.subarray(i, i + blockSize)
          );
          if (buf.length > 0) mp3Data.push(buf);
        }
      }

      const tail = encoder.flush();
      if (tail.length > 0) mp3Data.push(tail);

      const blob = new Blob(mp3Data, { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      console.error('MP3 conversion failed:', err);
      alert('MP3 conversion failed. Try downloading the M4A instead.');
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
  }

  // ── Global playerAudio event handlers (one element shared across all songs) ──
  playerAudio.addEventListener('timeupdate', () => {
    if (!currentCard || !playerAudio.duration) return;
    const prog = currentCard.querySelector('.progress-input');
    if (prog) prog.value = (playerAudio.currentTime / playerAudio.duration) * 100;
  });

  playerAudio.addEventListener('ended', () => {
    if (!currentCard) return;
    const endedCard = currentCard;
    const endedBtn = endedCard.querySelector('.play-pause-btn');
    const endedProg = endedCard.querySelector('.progress-input');
    if (endedBtn) endedBtn.textContent = '\u25B6';
    if (endedProg) endedProg.value = 0;
    endedCard.classList.remove('playing', 'open');
    currentCard = null;
    currentAudio = null;

    const cards = Array.from(document.querySelectorAll('.song-card'));
    const idx = cards.indexOf(endedCard);
    if (idx !== -1 && idx + 1 < cards.length) {
      const nextCard = cards[idx + 1];
      const nextSrc = nextCard.dataset.src;
      const nextPlayBtn = nextCard.querySelector('.play-pause-btn');
      if (nextSrc) {
        nextCard.classList.add('open', 'playing');
        currentCard = nextCard;
        currentAudio = playerAudio;
        playerAudio.src = nextSrc; // reuse same trusted element — no gesture needed
        playerAudio.play().catch(() => {});
        startSilentAudio();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        findSkipTime(nextSrc).then(t => {
          if (t > 0 && currentCard === nextCard && playerAudio.currentTime < t + 0.5)
            playerAudio.currentTime = t;
        });
        if (nextPlayBtn) nextPlayBtn.textContent = '\u23F8';
        const titleEl = nextCard.querySelector('.song-title');
        const titleText = titleEl ? titleEl.textContent : '';
        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: titleText,
            artist: 'Ben Keith',
            album: 'Ben Keith Music',
            artwork: [{ src: 'background.jpg', sizes: '512x512', type: 'image/jpeg' }]
          });
        }
        setTimeout(() => checkScrollingTitles(), 50);
      }
    } else {
      scheduleSilentAudioStop();
    }
  });

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
    card.dataset.src = m4aPath;

    // ── TOP: Player controls ──
    const controls = document.createElement('div');
    controls.className = 'song-controls';

    const playBtn = document.createElement('span');
    playBtn.className = 'play-pause-btn';
    playBtn.setAttribute('aria-hidden', 'true');
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

    // ── CENTER: Title + star ──
    const titleWrap = document.createElement('div');
    titleWrap.className = 'song-title-wrap';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'song-title';
    titleSpan.textContent = song.title;

    const starBtn = document.createElement('button');
    starBtn.className = 'star-btn' + (favorites.has(song.filename) ? ' starred' : '');
    starBtn.setAttribute('aria-label', 'Favorite');
    starBtn.textContent = favorites.has(song.filename) ? '\u2605' : '\u2606';

    titleWrap.appendChild(titleSpan);
    card.appendChild(titleWrap);
    card.appendChild(starBtn);

    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (favorites.has(song.filename)) {
        favorites.delete(song.filename);
        starBtn.textContent = '\u2606';
        starBtn.classList.remove('starred');
      } else {
        favorites.add(song.filename);
        starBtn.textContent = '\u2605';
        starBtn.classList.add('starred');
      }
      saveFavorites();
      // If currently viewing favorites, re-render to remove un-favorited song
      if (activeCategory === 'favorites') renderSongs();
    });

    // ── BOTTOM: Downloads ──
    const dlLinks = document.createElement('div');
    dlLinks.className = 'song-downloads';

    const m4aLink = document.createElement('a');
    m4aLink.className = 'download-btn';
    m4aLink.href = m4aPath;
    m4aLink.download = '';
    m4aLink.textContent = '\u2193 Download M4A';

    const mp3Btn = document.createElement('button');
    mp3Btn.className = 'download-btn mp3';
    mp3Btn.textContent = '\u2193 Download MP3';

    dlLinks.appendChild(m4aLink);
    dlLinks.appendChild(mp3Btn);
    card.appendChild(dlLinks);

    // ── BOTTOM-LEFT: Date ──
    const dateSpan = document.createElement('span');
    dateSpan.className = 'song-date';
    dateSpan.textContent = formatDate(song.date);
    card.appendChild(dateSpan);

    // ── Interactions ──

    // Clicking the card background/title toggles play
    card.addEventListener('click', (e) => {
      if (e.target.closest('a, .progress-input, .star-btn')) return;
      togglePlay(card, playBtn, progressInput, song, m4aPath);
    });

    // Keyboard: Enter or Space activates play
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        togglePlay(card, playBtn, progressInput, song, m4aPath);
      }
    });

    // Seek via progress bar
    progressInput.addEventListener('input', (e) => {
      e.stopPropagation();
      if (currentCard === card && playerAudio.duration) {
        playerAudio.currentTime = (progressInput.value / 100) * playerAudio.duration;
      }
    });

    // Prevent download clicks from toggling play
    m4aLink.addEventListener('click', e => e.stopPropagation());
    mp3Btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const outName = song.filename.replace(/\.m4a$/i, '.mp3');
      convertAndDownloadMp3(m4aPath, outName, mp3Btn);
    });

    return card;
  }

  function renderSongs() {
    stopCurrent();
    const container = document.getElementById('song-list');
    container.innerHTML = '';

    const pool = activeCategories.has('all')
      ? songs
      : activeCategories.has('favorites')
        ? songs.filter(s => {
            if (!favorites.has(s.filename)) return false;
            // if other cats also selected, further filter
            const nonSpecial = [...activeCategories].filter(c => c !== 'favorites');
            if (nonSpecial.length === 0) return true;
            const cats = parseCategories(s.filename);
            return nonSpecial.some(c => cats.includes(c));
          })
        : songs.filter(s => {
            const cats = parseCategories(s.filename);
            return [...activeCategories].some(c => cats.includes(c));
          });

    const sorted = [...pool].sort((a, b) => {
      const va = (a[sortKey] || '').toLowerCase();
      const vb = (b[sortKey] || '').toLowerCase();
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });

    sorted.forEach(song => container.appendChild(buildCard(song)));
    setTimeout(checkScrollingTitles, 50);
  }

  function checkScrollingTitles() {
    document.querySelectorAll('.song-title-wrap').forEach(wrap => {
      const title = wrap.querySelector('.song-title');
      if (!title) return;
      const overflow = title.scrollWidth - wrap.clientWidth;
      if (overflow > 4) {
        title.style.setProperty('--scroll-dist', `-${overflow}px`);
        title.classList.add('scrolling');
      } else {
        title.classList.remove('scrolling');
        title.style.removeProperty('--scroll-dist');
      }
    });
  }

  window.addEventListener('resize', checkScrollingTitles);

  document.querySelectorAll('[data-sort]').forEach(btn => {
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

  document.querySelectorAll('[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.cat;
      if (cat === 'all') {
        // All clears everything else
        activeCategories = new Set(['all']);
      } else {
        activeCategories.delete('all');
        if (activeCategories.has(cat)) {
          activeCategories.delete(cat);
          // If nothing left, fall back to All
          if (activeCategories.size === 0) activeCategories.add('all');
        } else {
          activeCategories.add(cat);
        }
      }
      updateCategoryButtons();
      renderSongs();
    });
  });

  try {
    await loadSongs();
    updateSortButtons();
    updateCategoryButtons();
    renderSongs();
  } catch (err) {
    console.error('Failed to load songs:', err);
    document.getElementById('song-list').innerHTML =
      '<p style="color:#555;text-align:center;padding:40px">Could not load song list. Make sure you\'re running this through a web server, not directly from the file system.</p>';
  }
})();
