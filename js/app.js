(async function () {
  let songs = [];
  let sortKey = 'title';
  let sortAsc = true;
  let activeCategories = new Set(['all']);
  let currentCard = null;
  let currentAudio = null;
  let favorites = new Set(JSON.parse(localStorage.getItem('bk-favorites') || '[]'));

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
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    }
    if (currentCard) {
      const btn = currentCard.querySelector('.play-pause-btn');
      const prog = currentCard.querySelector('.progress-input');
      if (btn) btn.textContent = '\u25B6';
      if (prog) prog.value = 0;
      currentCard.classList.remove('open', 'playing');
    }
    currentCard = null;
    currentAudio = null;
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
      if (currentCard) {
        const btn = currentCard.querySelector('.play-pause-btn');
        if (btn) btn.textContent = '\u23F8';
        currentCard.classList.add('playing');
      }
    });

    navigator.mediaSession.setActionHandler('pause', () => {
      if (currentAudio) currentAudio.pause();
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

  function togglePlay(card, audioEl, playBtn, progressInput, song) {
    if (!card.classList.contains('open')) {
      // Open card and start playing, stopping any other card first
      if (currentCard && currentCard !== card) stopCurrent();
      card.classList.add('open', 'playing');
      currentCard = card;
      currentAudio = audioEl;
      audioEl.play().catch(() => {});
      playBtn.textContent = '\u23F8';
      updateMediaSession(song);
    } else if (audioEl.paused) {
      // Card is open but paused: resume
      audioEl.play().catch(() => {});
      playBtn.textContent = '\u23F8';
      card.classList.add('playing');
      currentCard = card;
      currentAudio = audioEl;
      updateMediaSession(song);
    } else {
      // Card is open and playing: pause
      audioEl.pause();
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
      togglePlay(card, audioEl, playBtn, progressInput, song);
    });

    // Keyboard: Enter or Space activates play
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        togglePlay(card, audioEl, playBtn, progressInput, song);
      }
    });

    // Seek via progress bar
    progressInput.addEventListener('input', (e) => {
      e.stopPropagation();
      if (audioEl.duration) {
        audioEl.currentTime = (progressInput.value / 100) * audioEl.duration;
      }
    });

    // Prevent download clicks from toggling play
    m4aLink.addEventListener('click', e => e.stopPropagation());
    mp3Btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const outName = song.filename.replace(/\.m4a$/i, '.mp3');
      convertAndDownloadMp3(m4aPath, outName, mp3Btn);
    });

    // Sync progress bar with playback
    audioEl.addEventListener('timeupdate', () => {
      if (audioEl.duration) {
        progressInput.value = (audioEl.currentTime / audioEl.duration) * 100;
      }
    });

    // Reset on song end — autoplay next
    audioEl.addEventListener('ended', () => {
      playBtn.textContent = '\u25B6';
      progressInput.value = 0;
      card.classList.remove('playing', 'open');
      currentCard = null;
      currentAudio = null;
      // Find the next card in the list and play it
      const cards = Array.from(document.querySelectorAll('.song-card'));
      const idx = cards.indexOf(card);
      if (idx !== -1 && idx + 1 < cards.length) {
        const nextCard = cards[idx + 1];
        nextCard.click();
      }
    });

    return card;
  }

  function renderSongs() {
    const container = document.getElementById('song-list');
    container.innerHTML = '';
    currentCard = null;
    currentAudio = null;

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
