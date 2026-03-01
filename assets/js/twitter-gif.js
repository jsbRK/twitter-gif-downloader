// ============================================================
//  Twitter GIF Downloader — Backend Logic
//  All client-side: validate, fetch, extract, convert, download
// ============================================================

(function () {
    'use strict';

    // ── Constants ──────────────────────────────────────────────
    const TWITTER_URL_REGEX = /^https?:\/\/(www\.)?(twitter\.com|x\.com)\/[A-Za-z0-9_]+\/status\/(\d+)/;
    const PROXY_APIS = [
        {
            name: 'twitsave',
            url: (tweetUrl) => `https://twitsave.com/info?url=${encodeURIComponent(tweetUrl)}`,
            parse: 'html'
        },
        {
            name: 'ssstwitter',
            url: (tweetUrl) => `https://ssstwitter.com/api/parse?url=${encodeURIComponent(tweetUrl)}`,
            parse: 'json'
        }
    ];
    const RATE_LIMIT_MS = 800;

    // ── State ─────────────────────────────────────────────────
    let lastRequestTime = 0;
    let isProcessing = false;
    let currentMediaData = null;

    // ── DOM Refs (populated on init) ──────────────────────────
    const DOM = {};

    // ── Utility Functions ─────────────────────────────────────

    /**
     * Validates a Twitter/X status URL.
     * @param {string} url
     * @returns {{ valid: boolean, tweetId?: string, error?: string }}
     */
    function validateUrl(url) {
        if (!url || typeof url !== 'string') {
            return { valid: false, error: 'Please enter a Twitter/X URL.' };
        }

        const trimmed = url.trim();
        if (!trimmed) {
            return { valid: false, error: 'Please enter a Twitter/X URL.' };
        }

        // Basic URL check
        try {
            new URL(trimmed);
        } catch {
            return { valid: false, error: 'That doesn\'t look like a valid URL.' };
        }

        const match = trimmed.match(TWITTER_URL_REGEX);
        if (!match) {
            return {
                valid: false,
                error: 'Please enter a valid Twitter/X post URL (e.g. https://x.com/user/status/123456789).'
            };
        }

        return { valid: true, tweetId: match[3] };
    }

    // ── CORS Proxy Helpers ──────────────────────────────────────

    /**
     * Fetches a URL through a CORS proxy to bypass browser restrictions.
     * Races ALL proxies in parallel — first successful response wins.
     */
    async function fetchViaCorsProxy(targetUrl) {
        const proxies = [
            (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
            (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
            (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`
        ];

        const attempts = proxies.map(makeProxyUrl => {
            const proxyUrl = makeProxyUrl(targetUrl);
            return fetch(proxyUrl, {
                headers: { 'Accept': 'application/json, text/html, */*' }
            }).then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r;
            });
        });

        try {
            return await Promise.any(attempts);
        } catch {
            throw new Error('All CORS proxies failed.');
        }
    }

    /**
     * Parses video variants from Twitter syndication API response.
     */
    function parseSyndicationVideo(data) {
        const mediaDetails = data.mediaDetails || [];
        const videos = [];
        let thumbnail = data.mediaDetails?.[0]?.media_url_https || null;

        for (const media of mediaDetails) {
            if (media.type === 'video' || media.type === 'animated_gif') {
                if (media.video_info && media.video_info.variants) {
                    for (const variant of media.video_info.variants) {
                        if (variant.content_type === 'video/mp4' && variant.url) {
                            videos.push({
                                url: variant.url,
                                quality: variant.bitrate ? String(variant.bitrate) : 'unknown',
                                bitrate: variant.bitrate || 0
                            });
                        }
                    }
                }
                if (media.media_url_https) {
                    thumbnail = media.media_url_https;
                }
            }
        }

        // Also check for extended entities in the legacy format
        if (videos.length === 0 && data.video) {
            const v = data.video;
            if (v.variants) {
                for (const variant of v.variants) {
                    if (variant.type === 'video/mp4' || (variant.src && variant.src.includes('.mp4'))) {
                        videos.push({
                            url: variant.src || variant.url,
                            quality: variant.bitrate ? String(variant.bitrate) : 'unknown',
                            bitrate: variant.bitrate || 0
                        });
                    }
                }
            }
            if (v.poster) thumbnail = v.poster;
        }

        return { videos, thumbnail };
    }

    /**
     * Fetches tweet metadata using multiple strategies with fallbacks.
     * Strategy 1: Twitter Syndication API (via CORS proxy)
     * Strategy 2: fxtwitter.com open API (via CORS proxy)
     * All strategies race in parallel — fastest successful response wins.
     */
    async function fetchTweetMetadata(tweetUrl) {
        const validation = validateUrl(tweetUrl);
        if (!validation.valid) throw new Error(validation.error);

        // Rate limiting (lightweight)
        const now = Date.now();
        const elapsed = now - lastRequestTime;
        if (elapsed < RATE_LIMIT_MS) {
            await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
        }
        lastRequestTime = Date.now();

        const tweetId = validation.tweetId;

        // ── Build parallel strategy promises ─────────────────────
        // All three strategies launch simultaneously.
        // Promise.any resolves as soon as ONE succeeds with video data.

        const strategy1 = (async () => {
            const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=0`;
            const response = await fetchViaCorsProxy(syndicationUrl);
            const data = JSON.parse(await response.text());
            const { videos, thumbnail } = parseSyndicationVideo(data);
            if (videos.length === 0) throw new Error('No video in syndication response');
            return {
                tweetId,
                mediaType: data.mediaDetails?.[0]?.type === 'animated_gif' ? 'gif' : 'video',
                mediaUrls: videos,
                thumbnail,
                source: 'Twitter CDN'
            };
        })();

        const strategy2 = (async () => {
            const fxUrl = `https://api.fxtwitter.com/status/${tweetId}`;
            const response = await fetchViaCorsProxy(fxUrl);
            const data = JSON.parse(await response.text());
            const tweet = data.tweet || data;
            const media = tweet.media;
            if (!media?.videos?.length) throw new Error('No video in fxtwitter response');
            const videoList = media.videos.filter(v => v.url).map(v => ({
                url: v.url,
                quality: v.height ? `${v.height}p` : 'best',
                bitrate: v.bitrate || 0
            }));
            if (videoList.length === 0) throw new Error('No valid video URLs');
            return {
                tweetId,
                mediaType: media.videos[0]?.type === 'gif' ? 'gif' : 'video',
                mediaUrls: videoList,
                thumbnail: media.videos[0]?.thumbnail_url || media.photos?.[0]?.url || null,
                source: 'fxtwitter'
            };
        })();

        const strategy3 = (async () => {
            const response = await fetch('https://api.cobalt.tools/api/json', {
                method: 'POST',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: tweetUrl, vCodec: 'h264', vQuality: 'max', isNoTTWatermark: true })
            });
            if (!response.ok) throw new Error(`Cobalt HTTP ${response.status}`);
            const data = await response.json();
            if (data.status === 'stream' || data.status === 'redirect') {
                return {
                    tweetId, mediaType: 'video',
                    mediaUrls: [{ url: data.url, quality: 'best', bitrate: 0 }],
                    thumbnail: null, source: 'cobalt'
                };
            }
            if (data.status === 'picker' && data.picker) {
                return {
                    tweetId, mediaType: 'video',
                    mediaUrls: data.picker.map((p, i) => ({ url: p.url, quality: `option-${i + 1}`, bitrate: 0, thumb: p.thumb })),
                    thumbnail: data.picker[0]?.thumb || null, source: 'cobalt'
                };
            }
            throw new Error('Cobalt returned no usable data');
        })();

        // ── Race all strategies ──────────────────────────────────
        try {
            return await Promise.any([strategy1, strategy2, strategy3]);
        } catch (aggregateError) {
            // All failed — check if it's a "no video" situation
            const msgs = (aggregateError.errors || []).map(e => e.message);
            const noVideo = msgs.some(m => m.includes('No video'));
            return {
                tweetId,
                mediaType: noVideo ? 'none' : 'video',
                mediaUrls: [],
                thumbnail: null,
                source: 'none',
                error: noVideo
                    ? 'This tweet does not contain a video or GIF.'
                    : 'Could not extract media. The extraction services may be temporarily unavailable. Please try again in a moment.'
            };
        }
    }

    /**
     * Ensures a URL uses the https:// protocol.
     */
    function ensureHttps(url) {
        if (!url) return url;
        return url.replace(/^http:\/\//i, 'https://');
    }

    /**
     * Extracts the best quality MP4 URL from media metadata.
     */
    function extractVideo(mediaUrls) {
        if (!mediaUrls || mediaUrls.length === 0) return null;

        // Sort by bitrate (highest first) for best quality
        const sorted = [...mediaUrls].sort((a, b) => {
            return (b.bitrate || 0) - (a.bitrate || 0);
        });

        const url = sorted[0]?.url || mediaUrls[0]?.url || null;
        return ensureHttps(url);
    }

    /**
     * Converts an MP4 video to an animated GIF using gif.js (Web Worker-based).
     * Fetches the video via CORS proxy first to avoid canvas tainting.
     * @param {string} videoUrl
     * @returns {Promise<Blob>}
     */
    async function convertVideoToGif(videoUrl) {
        // Step 1: Fetch video as blob via CORS proxy
        updateProgress(10);
        let videoBlobUrl;
        try {
            const response = await fetchViaCorsProxy(videoUrl);
            const blob = await response.blob();
            videoBlobUrl = URL.createObjectURL(blob);
        } catch (e) {
            throw new Error('Failed to download video for GIF conversion: ' + e.message);
        }

        // Step 2: Load video element from blob URL
        updateProgress(15);
        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';

            const cleanup = () => URL.revokeObjectURL(videoBlobUrl);

            video.addEventListener('error', () => {
                cleanup();
                reject(new Error('Failed to load video for frame capture.'));
            });

            video.addEventListener('loadeddata', async () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d', { willReadFrequently: true });

                // Scale down for GIF
                const maxDim = 480;
                let w = video.videoWidth;
                let h = video.videoHeight;
                if (w > maxDim || h > maxDim) {
                    const scale = maxDim / Math.max(w, h);
                    w = Math.round(w * scale);
                    h = Math.round(h * scale);
                }
                w = w & ~1;
                h = h & ~1;
                canvas.width = w;
                canvas.height = h;

                const fps = 10;
                const duration = Math.min(video.duration, 8);
                const frameCount = Math.max(1, Math.floor(duration * fps));
                const frameDelay = Math.round(1000 / fps);

                // Step 3: Capture frames
                updateProgress(20);
                const frames = [];
                let captured = 0;

                try {
                    await new Promise((resolveCapture, rejectCapture) => {
                        function captureFrame() {
                            if (captured >= frameCount) {
                                resolveCapture();
                                return;
                            }
                            video.currentTime = Math.min(captured / fps, video.duration - 0.01);
                        }

                        video.addEventListener('seeked', function onSeeked() {
                            ctx.drawImage(video, 0, 0, w, h);
                            // Copy the canvas content for gif.js
                            frames.push(ctx.getImageData(0, 0, w, h));
                            captured++;
                            updateProgress(20 + Math.round((captured / frameCount) * 40));
                            captureFrame();
                        });

                        captureFrame();
                    });
                } catch (e) {
                    cleanup();
                    reject(new Error('Frame capture failed: ' + e.message));
                    return;
                }

                // Step 4: Encode with gif.js
                updateProgress(65);

                try {
                    // Fetch the gif.worker.js from CDN and create a blob URL
                    // (required because Web Workers can't load cross-origin scripts directly)
                    const workerBlob = await fetch('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js')
                        .then(r => r.blob())
                        .then(b => URL.createObjectURL(b));

                    const gif = new GIF({
                        workers: navigator.hardwareConcurrency || 2,
                        quality: 10,
                        width: w,
                        height: h,
                        workerScript: workerBlob,
                        dither: false
                    });

                    // Add all captured frames
                    for (const frame of frames) {
                        gif.addFrame(frame, { delay: frameDelay, copy: true });
                    }

                    gif.on('progress', (p) => {
                        updateProgress(65 + Math.round(p * 30));
                    });

                    gif.on('finished', (blob) => {
                        URL.revokeObjectURL(workerBlob);
                        cleanup();
                        updateProgress(100);
                        resolve(blob);
                    });

                    gif.render();
                } catch (e) {
                    cleanup();
                    reject(new Error('gif.js encoding failed: ' + e.message));
                }
            });

            video.src = videoBlobUrl;
            video.load();
        });
    }

    /**
     * Generates a download by creating a temporary anchor element.
     */
    function generateDownloadLink(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    /**
     * Downloads a file from a URL directly via CORS proxy.
     */
    async function downloadFromUrl(url, filename) {
        const safeUrl = ensureHttps(url);
        try {
            // Try direct fetch first
            const response = await fetch(safeUrl, { mode: 'cors' });
            if (!response.ok) throw new Error('Direct download failed');
            const blob = await response.blob();
            generateDownloadLink(blob, filename);
            return true;
        } catch {
            // Fallback: fetch via CORS proxy
            try {
                const response = await fetchViaCorsProxy(safeUrl);
                const blob = await response.blob();
                generateDownloadLink(blob, filename);
                return true;
            } catch {
                showToast('Download failed. Please try again.', 'error');
                return false;
            }
        }
    }



    // ── UI Helpers ─────────────────────────────────────────────

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    function timeAgo(timestamp) {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 60) return 'Just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    }

    function showError(message) {
        if (!DOM.errorMessage) return;
        DOM.errorMessage.classList.remove('hidden');
        DOM.errorMessage.querySelector('p').textContent = message;
    }

    function hideError() {
        if (!DOM.errorMessage) return;
        DOM.errorMessage.classList.add('hidden');
    }

    function showLoading() {
        DOM.loadingState?.classList.remove('hidden');
        DOM.previewSection?.classList.add('hidden');
        DOM.submitButton?.setAttribute('disabled', 'true');
        DOM.submitButton.innerHTML = `
            <svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Processing...
        `;
    }

    function hideLoading() {
        DOM.loadingState?.classList.add('hidden');
        DOM.submitButton?.removeAttribute('disabled');
        DOM.submitButton.innerHTML = `
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
            Fetch GIF
        `;
    }

    function updateProgress(percent) {
        const bar = DOM.progressBar;
        if (bar) {
            bar.style.width = `${percent}%`;
        }
        const label = DOM.progressLabel;
        if (label) {
            label.textContent = `${percent}%`;
        }
    }

    function showPreview(data) {
        DOM.previewSection?.classList.remove('hidden');
        DOM.loadingState?.classList.add('hidden');

        // Set thumbnail
        const thumbEl = DOM.previewThumb;
        if (thumbEl && data.thumbnail) {
            thumbEl.innerHTML = `<img src="${escapeHtml(data.thumbnail)}" alt="Tweet media preview" class="w-full h-full object-cover rounded-xl">`;
        } else if (thumbEl) {
            thumbEl.innerHTML = `
                <div class="w-full h-48 flex items-center justify-center bg-gradient-to-br from-sky-50 to-purple-50 dark:from-sky-900/20 dark:to-purple-900/20 rounded-xl">
                    <svg class="w-16 h-16 text-sky-400 dark:text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                    </svg>
                </div>`;
        }

        // Set metadata
        const metaEl = DOM.previewMeta;
        if (metaEl) {
            metaEl.innerHTML = `
                <div class="flex flex-wrap gap-2">
                    <span class="text-xs font-medium px-3 py-1 rounded-full bg-sky-100 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400">Tweet #${escapeHtml(data.tweetId)}</span>
                    <span class="text-xs font-medium px-3 py-1 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400">${data.mediaType || 'Video'}</span>
                    <span class="text-xs font-medium px-3 py-1 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">${data.source || 'Ready'}</span>
                </div>`;
        }
    }

    function showToast(message, type = 'success') {
        const toast = DOM.toast;
        if (!toast) return;

        const iconMap = {
            success: `<svg class="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
            error: `<svg class="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`,
            info: `<svg class="w-5 h-5 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`
        };

        toast.innerHTML = `${iconMap[type] || iconMap.info}<span>${escapeHtml(message)}</span>`;
        toast.classList.add('show');

        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // ── Controller ────────────────────────────────────────────

    const twitterGifController = {

        /**
         * Main endpoint: validate → fetch → extract → preview + download links
         */
        async processUrl() {
            if (isProcessing) return;

            hideError();
            const url = DOM.urlInput?.value?.trim();

            // Validate
            const validation = validateUrl(url);
            if (!validation.valid) {
                showError(validation.error);
                DOM.urlInput?.focus();
                return;
            }

            isProcessing = true;
            showLoading();
            updateProgress(5);

            try {
                // Fetch metadata
                updateProgress(20);
                const metadata = await fetchTweetMetadata(url);
                updateProgress(50);

                if (metadata.error && metadata.mediaUrls.length === 0) {
                    showError(metadata.error);
                    hideLoading();
                    isProcessing = false;
                    return;
                }

                // Extract best video URL
                const mp4Url = extractVideo(metadata.mediaUrls);
                updateProgress(70);

                currentMediaData = {
                    ...metadata,
                    mp4Url,
                    originalUrl: url
                };

                // Show preview
                showPreview(metadata);
                updateProgress(100);



                showToast('Media found! Ready to download.', 'success');

            } catch (err) {
                showError(err.message || 'Something went wrong. Please try again.');
                showToast('Failed to process URL', 'error');
            } finally {
                hideLoading();
                isProcessing = false;
            }
        },

        /**
         * Download as GIF (convert MP4 → GIF)
         */
        async downloadGif() {
            if (!currentMediaData?.mp4Url) {
                showToast('No media loaded. Paste a URL first!', 'error');
                return;
            }

            const btn = document.getElementById('download-gif-btn');
            const originalHTML = btn?.innerHTML;
            if (btn) {
                btn.setAttribute('disabled', 'true');
                btn.innerHTML = `
                    <svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Converting...`;
            }

            showToast('Converting to GIF... this may take a moment.', 'info');
            try {
                const gifBlob = await convertVideoToGif(currentMediaData.mp4Url);
                generateDownloadLink(gifBlob, `twitter-gif-${currentMediaData.tweetId}.gif`);
                showToast('GIF downloaded successfully!', 'success');
            } catch (err) {
                showToast('GIF conversion failed. Try downloading as MP4 instead.', 'error');
                console.error('GIF conversion error:', err);
            } finally {
                if (btn) {
                    btn.removeAttribute('disabled');
                    btn.innerHTML = originalHTML;
                }
            }
        },

        /**
         * Download as MP4
         */
        async downloadMp4() {
            if (!currentMediaData?.mp4Url) {
                showToast('No media loaded. Paste a URL first!', 'error');
                return;
            }

            const btn = document.getElementById('download-mp4-btn');
            const originalHTML = btn?.innerHTML;
            if (btn) {
                btn.setAttribute('disabled', 'true');
                btn.innerHTML = `
                    <svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Downloading...`;
            }

            showToast('Starting MP4 download...', 'info');
            try {
                const success = await downloadFromUrl(
                    currentMediaData.mp4Url,
                    `twitter-video-${currentMediaData.tweetId}.mp4`
                );
                if (success) showToast('MP4 downloaded!', 'success');
            } finally {
                if (btn) {
                    btn.removeAttribute('disabled');
                    btn.innerHTML = originalHTML;
                }
            }
        },



        /**
         * Copy media URL to clipboard
         */
        async copyLink() {
            if (!currentMediaData?.mp4Url) {
                showToast('No media URL available.', 'error');
                return;
            }

            try {
                await navigator.clipboard.writeText(currentMediaData.mp4Url);
                showToast('Link copied to clipboard!', 'success');
                DOM.copyBtn?.classList.add('copy-success');
                setTimeout(() => DOM.copyBtn?.classList.remove('copy-success'), 600);
            } catch {
                showToast('Failed to copy link.', 'error');
            }
        },

        /**
         * Share via Web Share API
         */
        async share() {
            const shareData = {
                title: 'Twitter GIF Download',
                text: `Check out this GIF from Twitter!`,
                url: currentMediaData?.originalUrl || window.location.href
            };

            if (navigator.share) {
                try {
                    await navigator.share(shareData);
                } catch { /* user cancelled */ }
            } else {
                // Fallback: copy URL
                this.copyLink();
            }
        }
    };

    // ── Initialization ────────────────────────────────────────

    function initDom() {
        DOM.urlInput = document.getElementById('twitter-url-input');
        DOM.submitButton = document.getElementById('fetch-gif-btn');
        DOM.errorMessage = document.getElementById('gif-error-message');
        DOM.loadingState = document.getElementById('gif-loading-state');
        DOM.previewSection = document.getElementById('gif-preview-section');
        DOM.previewThumb = document.getElementById('gif-preview-thumb');
        DOM.previewMeta = document.getElementById('gif-preview-meta');
        DOM.progressBar = document.getElementById('gif-progress-bar');
        DOM.progressLabel = document.getElementById('gif-progress-label');

        DOM.toast = document.getElementById('gif-toast');
        DOM.copyBtn = document.getElementById('copy-link-btn');
    }

    function bindEvents() {
        // Submit button
        DOM.submitButton?.addEventListener('click', () => twitterGifController.processUrl());

        // Enter key on input
        DOM.urlInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') twitterGifController.processUrl();
        });

        // Download buttons
        document.getElementById('download-gif-btn')?.addEventListener('click', () => twitterGifController.downloadGif());
        document.getElementById('download-mp4-btn')?.addEventListener('click', () => twitterGifController.downloadMp4());


        // Copy & Share
        DOM.copyBtn?.addEventListener('click', () => twitterGifController.copyLink());
        document.getElementById('share-btn')?.addEventListener('click', () => twitterGifController.share());



        // Paste detection
        DOM.urlInput?.addEventListener('paste', () => {
            setTimeout(() => {
                const val = DOM.urlInput.value.trim();
                if (val && TWITTER_URL_REGEX.test(val)) {
                    twitterGifController.processUrl();
                }
            }, 100);
        });
    }

    function init() {
        initDom();
        bindEvents();

    }

    // Boot
    document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', init)
        : init();

    // Expose controller
    window.twitterGifController = twitterGifController;

})();
