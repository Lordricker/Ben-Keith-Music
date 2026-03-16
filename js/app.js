(async function () {
  let songs = [];
  let sortKey = 'title';
  let sortAsc = true;
  let openDetail = null;

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

  function buildCard(song) {
    const card = document.createElement('div');
    card.className = 'song-card';

    // ── Song button ──
    const btn = document.createElement('button');
    btn.className = 'song-button';
    btn.setAttribute('aria-expanded', 'false');

    const titleSpan = document.createElement('span');
    titleSpan.className = 'song-title';
    titleSpan.textContent = song.title;
    btn.appendChild(titleSpan);

    // ── Detail panel ──
    const detail = document.createElement('div');
    detail.className = 'song-detail';

    // Build safe file paths (encode spaces/special chars in filename only)
    const encodedFilename = song.filename.split('/').map(encodeURIComponent).join('/');
    const mp3Filename = song.filename.replace(/\.m4a$/i, '.mp3');
    const encodedMp3 = mp3Filename.split('/').map(encodeURIComponent).join('/');
    const m4aPath = 'music/' + encodedFilename;
    const mp3Path = 'music/mp3/' + encodedMp3;

    const meta = document.createElement('div');
    meta.className = 'song-meta';

    const dateSpan = document.createElement('span');
    dateSpan.textContent = '\uD83D\uDCC5 ' + formatDate(song.date);
    meta.appendChild(dateSpan);

    if (song.description) {
      const descSpan = document.createElement('span');
      descSpan.className = 'song-description';
      descSpan.textContent = song.description;
      meta.appendChild(descSpan);
    }

    const audioEl = document.createElement('audio');
    audioEl.controls = true;
    audioEl.preload = 'none';
    const source = document.createElement('source');
    source.src = m4aPath;
    source.type = 'audio/mp4';
    audioEl.appendChild(source);
    audioEl.insertAdjacentText('beforeend', 'Your browser does not support the audio element.');

    const dlLinks = document.createElement('div');
    dlLinks.className = 'download-links';

    const m4aLink = document.createElement('a');
    m4aLink.className = 'download-btn';
    m4aLink.href = m4aPath;
    m4aLink.download = '';
    m4aLink.textContent = '\u2193 Download M4A (high quality)';

    const mp3Link = document.createElement('a');
    mp3Link.className = 'download-btn mp3';
    mp3Link.href = mp3Path;
    mp3Link.download = '';
    mp3Link.textContent = '\u2193 Download MP3';

    dlLinks.appendChild(m4aLink);
    dlLinks.appendChild(mp3Link);

    detail.appendChild(meta);
    detail.appendChild(audioEl);
    detail.appendChild(dlLinks);

    // ── Toggle expand on click ──
    btn.addEventListener('click', () => {
      const isOpen = detail.classList.contains('open');

      // Close the previously open card
      if (openDetail && openDetail !== detail) {
        openDetail.classList.remove('open');
        openDetail.previousElementSibling.setAttribute('aria-expanded', 'false');
        const prevAudio = openDetail.querySelector('audio');
        if (prevAudio) { prevAudio.pause(); prevAudio.currentTime = 0; }
      }

      const nowOpen = !isOpen;
      detail.classList.toggle('open', nowOpen);
      btn.setAttribute('aria-expanded', String(nowOpen));
      openDetail = nowOpen ? detail : null;
    });

    card.appendChild(btn);
    card.appendChild(detail);
    return card;
  }

  function renderSongs() {
    const container = document.getElementById('song-list');
    container.innerHTML = '';
    openDetail = null;

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
