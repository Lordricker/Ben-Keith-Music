(async function () {
  let songs = [];
  let sortKey = 'title';
  let sortAsc = true;
  let activeCategories = new Set(['all']);
  let currentCard = null;
  let currentAudio = null;
  let favorites = new Set(JSON.parse(localStorage.getItem('bk-favorites') || '[]'));
  const silenceCache = new Map(); // src -> seconds to skip

  // ── Ping-pong dual audio engine ──────────────────────────────────────────────
  // Slot A plays the current song at full volume.
  // Slot B plays the NEXT song at near-zero volume starting ~2s before A ends.
  // When A fires 'ended', B is already playing — we just raise B's volume to 1.
  // NO play() call is made in the background, so Android cannot block it.
  // Both slots are started during the original user tap, keeping them trusted.
  const audioSlots  = [new Audio(), new Audio()];
  let activeSlot    = 0;     // which slot is audibly playing
  let songQueue     = [];    // [{src, card}] built when user taps a song
  let queuePos      = 0;     // current position in songQueue
  let bufferArmed   = false; // true once buffer slot has started the next song

  // Tiny silent WAV blob URL — keeps buffer slot pre-activated between songs
  const _silentWav = (() => {
    const sr = 8000, n = sr, b = new ArrayBuffer(44 + n * 2), dv = new DataView(b);
    const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    w(0,'RIFF'); dv.setUint32(4,36+n*2,true); w(8,'WAVE'); w(12,'fmt ');
    dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,1,true);
    dv.setUint32(24,sr,true); dv.setUint32(28,sr*2,true);
    dv.setUint16(32,2,true); dv.setUint16(34,16,true);
    w(36,'data'); dv.setUint32(40,n*2,true);
    return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  })();

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
    audioSlots[0].pause();
    audioSlots[0].loop = false;
    audioSlots[1].pause();
    audioSlots[1].loop = false;
    songQueue = [];
    queuePos = 0;
    bufferArmed = false;
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

    navigator.mediaSession.setActionHandler('nexttrack', () => { advanceQueue(1); });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      const el = audioSlots[activeSlot];
      if (el.currentTime > 3) { el.currentTime = 0; } else { advanceQueue(-1); }
    });
  }

  // Skip to a different queue position (used by lock-screen prev/next buttons)
  function advanceQueue(delta) {
    const newPos = queuePos + delta;
    if (newPos < 0 || newPos >= songQueue.length) return;
    // Stop buffer slot, reset flag
    audioSlots[1 - activeSlot].pause();
    bufferArmed = false;
    queuePos = newPos;
    // Close old card
    if (currentCard) {
      const b = currentCard.querySelector('.play-pause-btn');
      const p = currentCard.querySelector('.progress-input');
      if (b) b.textContent = '\u25B6';
      if (p) p.value = 0;
      currentCard.classList.remove('open', 'playing');
    }
    // Start new song on active slot (Media Session callbacks are trusted)
    const { src, card } = songQueue[queuePos];
    audioSlots[activeSlot].src = src;
    audioSlots[activeSlot].play().catch(() => {});
    card.classList.add('open', 'playing');
    const btn = card.querySelector('.play-pause-btn');
    if (btn) btn.textContent = '\u23F8';
    currentCard = card;
    currentAudio = audioSlots[activeSlot];
    // Re-prime buffer slot with silent wav
    audioSlots[1 - activeSlot].src = _silentWav;
    audioSlots[1 - activeSlot].loop = true;
    audioSlots[1 - activeSlot].volume = 0.001;
    audioSlots[1 - activeSlot].play().catch(() => {});
    if ('mediaSession' in navigator) {
      const titleEl = card.querySelector('.song-title');
      navigator.mediaSession.metadata = new MediaMetadata({
        title: titleEl ? titleEl.textContent : '',
        artist: 'Ben Keith', album: 'Ben Keith Music',
        artwork: [{ src: 'background.jpg', sizes: '512x512', type: 'image/jpeg' }]
      });
      navigator.mediaSession.playbackState = 'playing';
    }
    findSkipTime(src).then(t => {
      if (t > 0 && currentCard === card && audioSlots[activeSlot].currentTime < t + 0.5)
        audioSlots[activeSlot].currentTime = t;
    });
    setTimeout(() => checkScrollingTitles(), 50);
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
      // New song tapped — build queue from this card onward
      stopCurrent();
      const allCards = Array.from(document.querySelectorAll('.song-card'));
      songQueue = allCards.slice(allCards.indexOf(card)).map(c => ({ src: c.dataset.src, card: c }));
      queuePos = 0;
      activeSlot = 0;
      bufferArmed = false;

      // Start active slot — this is the user gesture, granting trust to both slots
      audioSlots[0].loop = false;
      audioSlots[0].src = m4aSrc;
      audioSlots[0].volume = 1;
      audioSlots[0].play().catch(() => {});

      // Pre-activate buffer slot with silent wav within the same user gesture
      audioSlots[1].src = _silentWav;
      audioSlots[1].loop = true;
      audioSlots[1].volume = 0.001;
      audioSlots[1].play().catch(() => {});

      card.classList.add('open', 'playing');
      currentCard = card;
      currentAudio = audioSlots[0];
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      playBtn.textContent = '\u23F8';
      updateMediaSession(song);
      findSkipTime(m4aSrc).then(t => {
        if (t > 0 && currentCard === card && audioSlots[0].currentTime < t + 0.5)
          audioSlots[0].currentTime = t;
      });
    } else if (audioSlots[activeSlot].paused) {
      // Resume — restore both slots (user is on screen, play() is fine here)
      audioSlots[activeSlot].play().catch(() => {});
      audioSlots[1 - activeSlot].src = _silentWav;
      audioSlots[1 - activeSlot].loop = true;
      audioSlots[1 - activeSlot].volume = 0.001;
      audioSlots[1 - activeSlot].play().catch(() => {});
      bufferArmed = false;
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      playBtn.textContent = '\u23F8';
      card.classList.add('playing');
      currentCard = card;
      currentAudio = audioSlots[activeSlot];
      updateMediaSession(song);
    } else {
      // Pause both slots
      audioSlots[activeSlot].pause();
      audioSlots[1 - activeSlot].pause();
      bufferArmed = false;
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

  // ── Dual-slot event handlers ─────────────────────────────────────────────────
  function handleTimeUpdate(slot) {
    if (slot !== activeSlot) return;
    const el = audioSlots[slot];
    if (!currentCard || !el.duration) return;
    // Update progress bar
    const prog = currentCard.querySelector('.progress-input');
    if (prog) prog.value = (el.currentTime / el.duration) * 100;
    // Arm buffer slot when within 2s of the end
    if (!bufferArmed && queuePos + 1 < songQueue.length) {
      if (el.duration - el.currentTime < 2.0) {
        const bufSlot = 1 - activeSlot;
        const nextSrc = songQueue[queuePos + 1].src;
        // Switch buffer slot from silent wav to next song (still playing, just new src)
        // play() here is safe: active audio session is alive (slot A still playing)
        audioSlots[bufSlot].loop = false;
        audioSlots[bufSlot].src = nextSrc;
        audioSlots[bufSlot].volume = 0.001;
        audioSlots[bufSlot].play().catch(() => {});
        bufferArmed = true;
      }
    }
  }

  function handleEnded(slot) {
    if (slot !== activeSlot) return;
    // Close the card that just finished
    if (currentCard) {
      const btn = currentCard.querySelector('.play-pause-btn');
      const prog = currentCard.querySelector('.progress-input');
      if (btn) btn.textContent = '\u25B6';
      if (prog) prog.value = 0;
      currentCard.classList.remove('playing', 'open');
    }

    queuePos++;
    if (queuePos >= songQueue.length) {
      audioSlots[1 - slot].pause();
      currentCard = null;
      currentAudio = null;
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
      return;
    }

    const nextItem = songQueue[queuePos];
    const bufSlot  = 1 - activeSlot;

    if (bufferArmed) {
      // ── THE KEY: buffer slot is already playing next song at 0.001 volume ──
      // Just seek to beginning and raise volume. NO play() call. Cannot be blocked.
      audioSlots[bufSlot].currentTime = 0;
      audioSlots[bufSlot].volume = 1;
    } else {
      // Very short song — buffer wasn't armed in time; must call play() as fallback
      audioSlots[bufSlot].loop = false;
      audioSlots[bufSlot].src = nextItem.src;
      audioSlots[bufSlot].volume = 1;
      audioSlots[bufSlot].play().catch(() => {});
    }

    // Swap: buffer is now active
    activeSlot  = bufSlot;
    bufferArmed = false;

    // Open the new card
    nextItem.card.classList.add('open', 'playing');
    const nextBtn = nextItem.card.querySelector('.play-pause-btn');
    if (nextBtn) nextBtn.textContent = '\u23F8';
    currentCard  = nextItem.card;
    currentAudio = audioSlots[activeSlot];

    // Re-prime the (now freed) old slot with silent wav so it's ready to be used as buffer
    // play() is safe here because activeSlot is now producing audio
    const newBufSlot = 1 - activeSlot;
    audioSlots[newBufSlot].src  = _silentWav;
    audioSlots[newBufSlot].loop = true;
    audioSlots[newBufSlot].volume = 0.001;
    audioSlots[newBufSlot].play().catch(() => {});

    // Media session
    const titleEl = nextItem.card.querySelector('.song-title');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: titleEl ? titleEl.textContent : '',
        artist: 'Ben Keith', album: 'Ben Keith Music',
        artwork: [{ src: 'background.jpg', sizes: '512x512', type: 'image/jpeg' }]
      });
      navigator.mediaSession.playbackState = 'playing';
    }

    // Skip silence if applicable
    findSkipTime(nextItem.src).then(t => {
      if (t > 0 && currentCard === nextItem.card && audioSlots[activeSlot].currentTime < t + 0.5)
        audioSlots[activeSlot].currentTime = t;
    });

    setTimeout(() => checkScrollingTitles(), 50);
  }

  audioSlots[0].addEventListener('timeupdate', () => handleTimeUpdate(0));
  audioSlots[1].addEventListener('timeupdate', () => handleTimeUpdate(1));
  audioSlots[0].addEventListener('ended', () => handleEnded(0));
  audioSlots[1].addEventListener('ended', () => handleEnded(1));

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
      if (activeCategories.has('favorites')) renderSongs();
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
      if (currentCard === card && audioSlots[activeSlot].duration) {
        audioSlots[activeSlot].currentTime = (progressInput.value / 100) * audioSlots[activeSlot].duration;
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
      if (sortKey === 'date') {
        const [ay, am, ad] = (a.date || '0000-00-00').split('-').map(Number);
        const [by, bm, bd] = (b.date || '0000-00-00').split('-').map(Number);
        const diff = ay !== by ? ay - by : am !== bm ? am - bm : ad - bd;
        return sortAsc ? diff : -diff;
      }
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
