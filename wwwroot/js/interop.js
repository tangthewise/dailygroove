// DailyGroove WASM interop
// All functions live under window.DailyGrooveInterop

window.DailyGrooveInterop = (function () {

    // ── IndexedDB helpers ────────────────────────────────────────────────────
    const DB_NAME = 'DailyGrooveStore';
    const DB_VERSION = 1;
    const STORE_NAME = 'blobs';

    function openIdb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = e => e.target.result.createObjectStore(STORE_NAME);
            req.onsuccess = e => resolve(e.target.result);
            req.onerror = e => reject(e.target.error);
        });
    }

    async function idbGet(key) {
        const db = await openIdb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(key);
            req.onsuccess = e => resolve(e.target.result ?? null);
            req.onerror = e => reject(e.target.error);
        });
    }

    async function idbSet(key, value) {
        const db = await openIdb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const req = tx.objectStore(STORE_NAME).put(value, key);
            req.onsuccess = () => resolve();
            req.onerror = e => reject(e.target.error);
        });
    }

    // ── JSON data persistence ────────────────────────────────────────────────

    async function dataGet(key) {
        try { return await idbGet(key) ?? null; } catch { return null; }
    }

    async function dataSet(key, value) {
        try { await idbSet(key, value); } catch (e) { console.warn('DailyGroove: dataSet failed', e); }
    }

    // ── Audio ────────────────────────────────────────────────────────────────
    let _audioCtx = null;

    function getAudioCtx() {
        if (!_audioCtx || _audioCtx.state === 'closed') {
            _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (_audioCtx.state === 'suspended') {
            _audioCtx.resume();
        }
        return _audioCtx;
    }

    function playOscillator(frequency, durationMs, volume, startOffset) {
        const ctx = getAudioCtx();
        const t = ctx.currentTime + (startOffset / 1000);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(volume, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + durationMs / 1000 - 0.01);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + durationMs / 1000);
    }

    function playBeep(frequency, durationMs, volume) {
        try { playOscillator(frequency, durationMs, volume, 0); } catch (e) { console.warn(e); }
    }

    // segments: [{frequency, durationMs, gapMs, volume}]
    function playSequence(segments) {
        let offset = 0;
        for (const seg of segments) {
            try { playOscillator(seg.frequency, seg.durationMs, seg.volume, offset); } catch (e) { console.warn(e); }
            offset += seg.durationMs + seg.gapMs;
        }
    }

    // Unlock audio context on first user gesture (needed for mobile)
    function unlockAudio() {
        try { getAudioCtx(); } catch {}
    }

    // ── Speech ───────────────────────────────────────────────────────────────
    function getVoices() {
        const voices = speechSynthesis.getVoices();
        return voices.map(v => ({
            name: v.name,
            displayName: v.name,
            language: v.lang.split('-')[0],
            country: v.lang.split('-')[1] ?? '',
            voiceUri: v.voiceURI
        }));
    }

    function speak(text, voiceName) {
        if (!('speechSynthesis' in window)) return;
        speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(text);
        if (voiceName) {
            const voice = speechSynthesis.getVoices().find(v => v.name === voiceName);
            if (voice) utt.voice = voice;
        }
        speechSynthesis.speak(utt);
    }

    function cancelSpeech() {
        if ('speechSynthesis' in window) speechSynthesis.cancel();
    }

    // ── Wake Lock ────────────────────────────────────────────────────────────
    // On Android Chrome / desktop: uses the Screen Wake Lock API.
    // On iOS Safari (Wake Lock API unavailable): falls back to a 25-second
    // silent audio loop — the AudioContext keeps the screen alive on iOS.

    let _wakeLock = null;
    let _silentInterval = null;

    function _playSilentTick() {
        try {
            const ctx = getAudioCtx();
            const buf = ctx.createBuffer(1, ctx.sampleRate * 0.1, ctx.sampleRate); // 100ms silence
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start();
        } catch {}
    }

    function _startSilentLoop() {
        if (_silentInterval) return;
        _playSilentTick();
        _silentInterval = setInterval(_playSilentTick, 25000); // every 25 s
    }

    function _stopSilentLoop() {
        if (_silentInterval) { clearInterval(_silentInterval); _silentInterval = null; }
    }

    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                _wakeLock = await navigator.wakeLock.request('screen');
                return; // Wake Lock API worked — no need for audio fallback
            } catch {}
        }
        // Fallback for iOS Safari
        _startSilentLoop();
    }

    async function releaseWakeLock() {
        _stopSilentLoop();
        if (_wakeLock) {
            try { await _wakeLock.release(); } catch {}
            _wakeLock = null;
        }
    }

    // ── Share / File ─────────────────────────────────────────────────────────
    async function shareFile(content, fileName, title) {
        const blob = new Blob([content], { type: 'application/json' });
        const file = new File([blob], fileName, { type: 'application/json' });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ title, files: [file] });
                return true;
            } catch {}
        }
        // Fallback: trigger download
        downloadFile(content, fileName);
        return true;
    }

    function downloadFile(content, fileName) {
        const blob = new Blob([content], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function pickJsonFile(prompt) {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.style.display = 'none';
            document.body.appendChild(input);

            input.onchange = () => {
                const file = input.files[0];
                if (!file) { document.body.removeChild(input); resolve(null); return; }
                const reader = new FileReader();
                reader.onload = e => { document.body.removeChild(input); resolve(e.target.result); };
                reader.onerror = () => { document.body.removeChild(input); resolve(null); };
                reader.readAsText(file);
            };

            input.oncancel = () => { document.body.removeChild(input); resolve(null); };
            input.click();
        });
    }

    // ── LocalStorage ─────────────────────────────────────────────────────────
    function lsGet(key) { return localStorage.getItem(key); }
    function lsSet(key, value) { localStorage.setItem(key, value); }
    function lsRemove(key) { localStorage.removeItem(key); }

    // ── History ──────────────────────────────────────────────────────────────
    function historyBack() { history.back(); }

    // Public API
    return {
        dataGet,
        dataSet,
        playBeep,
        playSequence,
        unlockAudio,
        getVoices,
        speak,
        cancelSpeech,
        requestWakeLock,
        releaseWakeLock,
        shareFile,
        downloadFile,
        pickJsonFile,
        lsGet,
        lsSet,
        lsRemove,
        historyBack,
    };
})();
