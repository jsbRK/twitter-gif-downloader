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
    const RATE_LIMIT_MS = 2000;

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
     * Tries multiple proxies in sequence.
     */
    async function fetchViaCorsProxy(targetUrl) {
        const proxies = [
            (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
            (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
            (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`
        ];

        for (const makeProxyUrl of proxies) {
            try {
                const proxyUrl = makeProxyUrl(targetUrl);
                const response = await fetch(proxyUrl, {
                    headers: { 'Accept': 'application/json, text/html, */*' }
                });
                if (response.ok) {
                    return response;
                }
            } catch (e) {
                console.warn(`CORS proxy failed for ${targetUrl}:`, e.message);
            }
        }
        throw new Error('All CORS proxies failed.');
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
     * Strategy 3: Cobalt API
     */
    async function fetchTweetMetadata(tweetUrl) {
        const validation = validateUrl(tweetUrl);
        if (!validation.valid) throw new Error(validation.error);

        // Rate limiting
        const now = Date.now();
        const elapsed = now - lastRequestTime;
        if (elapsed < RATE_LIMIT_MS) {
            await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
        }
        lastRequestTime = Date.now();

        const tweetId = validation.tweetId;
        const errors = [];

        // ── Strategy 1: Twitter Syndication API ─────────────────
        // This is Twitter's own public endpoint used for embeds
        try {
            const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=0`;
            const response = await fetchViaCorsProxy(syndicationUrl);
            const text = await response.text();

            let data;
            try {
                data = JSON.parse(text);
            } catch {
                throw new Error('Invalid JSON from syndication API');
            }

            const { videos, thumbnail } = parseSyndicationVideo(data);

            if (videos.length > 0) {
                return {
                    tweetId,
                    mediaType: data.mediaDetails?.[0]?.type === 'animated_gif' ? 'gif' : 'video',
                    mediaUrls: videos,
                    thumbnail,
                    source: 'Twitter CDN'
                };
            }

            // If we got data but no videos, check if it's a photo or text-only tweet
            if (data.text && videos.length === 0) {
                errors.push('This tweet does not contain a video or GIF.');
            }
        } catch (e) {
            console.warn('Strategy 1 (Syndication) failed:', e.message);
            errors.push(`Syndication: ${e.message}`);
        }

        // ── Strategy 2: fxtwitter / vxtwitter API ───────────────
        // Open-source Twitter frontend that exposes tweet data as JSON
        try {
            const fxUrl = `https://api.fxtwitter.com/status/${tweetId}`;
            const response = await fetchViaCorsProxy(fxUrl);
            const text = await response.text();

            let data;
            try {
                data = JSON.parse(text);
            } catch {
                throw new Error('Invalid JSON from fxtwitter');
            }

            const tweet = data.tweet || data;
            const media = tweet.media;

            if (media && media.videos && media.videos.length > 0) {
                const videoList = [];
                for (const v of media.videos) {
                    if (v.url) {
                        videoList.push({
                            url: v.url,
                            quality: v.height ? `${v.height}p` : 'best',
                            bitrate: v.bitrate || 0
                        });
                    }
                }
                if (videoList.length > 0) {
                    return {
                        tweetId,
                        mediaType: media.videos[0]?.type === 'gif' ? 'gif' : 'video',
                        mediaUrls: videoList,
                        thumbnail: media.videos[0]?.thumbnail_url || media.photos?.[0]?.url || null,
                        source: 'fxtwitter'
                    };
                }
            }

            // Check for mosaic/photo-only
            if (media && media.photos && media.photos.length > 0 && (!media.videos || media.videos.length === 0)) {
                errors.push('This tweet contains images but no videos or GIFs.');
            }
        } catch (e) {
            console.warn('Strategy 2 (fxtwitter) failed:', e.message);
            errors.push(`fxtwitter: ${e.message}`);
        }

        // ── Strategy 3: Cobalt API ──────────────────────────────
        try {
            const response = await fetch('https://api.cobalt.tools/api/json', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    url: tweetUrl,
                    vCodec: 'h264',
                    vQuality: 'max',
                    isNoTTWatermark: true
                })
            });

            if (response.ok) {
                const data = await response.json();
                if (data.status === 'stream' || data.status === 'redirect') {
                    return {
                        tweetId,
                        mediaType: 'video',
                        mediaUrls: [{ url: data.url, quality: 'best', bitrate: 0 }],
                        thumbnail: null,
                        source: 'cobalt'
                    };
                }
                if (data.status === 'picker' && data.picker) {
                    return {
                        tweetId,
                        mediaType: 'video',
                        mediaUrls: data.picker.map((p, i) => ({
                            url: p.url,
                            quality: `option-${i + 1}`,
                            bitrate: 0,
                            thumb: p.thumb
                        })),
                        thumbnail: data.picker[0]?.thumb || null,
                        source: 'cobalt'
                    };
                }
            }
        } catch (e) {
            console.warn('Strategy 3 (Cobalt) failed:', e.message);
            errors.push(`Cobalt: ${e.message}`);
        }

        // ── All strategies failed ───────────────────────────────
        // Check if any strategy said "no video"
        const noVideoMsg = errors.find(e => e.includes('does not contain') || e.includes('images but no'));
        if (noVideoMsg) {
            return {
                tweetId,
                mediaType: 'none',
                mediaUrls: [],
                thumbnail: null,
                source: 'none',
                error: noVideoMsg
            };
        }

        return {
            tweetId,
            mediaType: 'video',
            mediaUrls: [],
            thumbnail: null,
            source: 'fallback',
            error: 'Could not extract media. The extraction services may be temporarily unavailable. Please try again in a moment.'
        };
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

        return sorted[0]?.url || mediaUrls[0]?.url || null;
    }

    /**
     * Converts an MP4 video to an animated GIF.
     * First fetches the video via CORS proxy to avoid cross-origin restrictions,
     * then captures frames on a canvas and encodes a real animated GIF.
     * @param {string} videoUrl
     * @returns {Promise<Blob>}
     */
    async function convertVideoToGif(videoUrl) {
        // Step 1: Fetch video as blob via CORS proxy to avoid canvas tainting
        updateProgress(12);
        let videoBlobUrl;
        try {
            const response = await fetchViaCorsProxy(videoUrl);
            const blob = await response.blob();
            videoBlobUrl = URL.createObjectURL(blob);
        } catch (e) {
            throw new Error('Failed to download video for GIF conversion: ' + e.message);
        }

        // Step 2: Load video from blob URL
        updateProgress(18);
        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';

            const cleanup = () => {
                URL.revokeObjectURL(videoBlobUrl);
            };

            video.addEventListener('error', () => {
                cleanup();
                reject(new Error('Failed to load video for frame capture.'));
            });

            video.addEventListener('loadeddata', () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d', { willReadFrequently: true });

                // Scale down for reasonable GIF size
                const maxDim = 320;
                let w = video.videoWidth;
                let h = video.videoHeight;
                if (w > maxDim || h > maxDim) {
                    const scale = maxDim / Math.max(w, h);
                    w = Math.round(w * scale);
                    h = Math.round(h * scale);
                }
                // GIF dimensions must be even for some decoders
                w = w & ~1;
                h = h & ~1;
                canvas.width = w;
                canvas.height = h;

                const fps = 10;
                const duration = Math.min(video.duration, 10); // Cap at 10s for GIF size
                const frameCount = Math.max(1, Math.floor(duration * fps));
                const frameDelay = Math.round(100 / fps); // in 1/100ths of a second
                let captured = 0;
                const frames = [];

                function captureFrame() {
                    if (captured >= frameCount) {
                        // Step 3: Encode animated GIF
                        updateProgress(80);
                        try {
                            const gifBlob = encodeAnimatedGif(frames, w, h, frameDelay);
                            cleanup();
                            resolve(gifBlob);
                        } catch (err) {
                            cleanup();
                            reject(new Error('GIF encoding failed: ' + err.message));
                        }
                        return;
                    }

                    const time = (captured / fps);
                    video.currentTime = Math.min(time, video.duration - 0.01);
                }

                video.addEventListener('seeked', function onSeeked() {
                    ctx.drawImage(video, 0, 0, w, h);
                    frames.push(ctx.getImageData(0, 0, w, h));
                    captured++;
                    updateProgress(20 + Math.round((captured / frameCount) * 58));
                    // Use requestAnimationFrame to avoid blocking
                    requestAnimationFrame(() => captureFrame());
                });

                captureFrame();
            });

            video.src = videoBlobUrl;
            video.load();
        });
    }

    // ══════════════════════════════════════════════════════════
    //  Inline Animated GIF Encoder (GIF89a with LZW)
    //  No external dependencies required.
    // ══════════════════════════════════════════════════════════

    /**
     * Quantizes an RGBA ImageData to a 256-color palette using median-cut.
     * Returns { indexedPixels: Uint8Array, palette: [r,g,b,...] flat array of 256*3 }
     */
    function quantizeFrame(imageData) {
        const pixels = imageData.data;
        const numPixels = pixels.length / 4;

        // Sample pixels for palette building (every Nth pixel for speed)
        const sampleStep = Math.max(1, Math.floor(numPixels / 10000));
        const samples = [];
        for (let i = 0; i < numPixels; i += sampleStep) {
            const off = i * 4;
            samples.push([pixels[off], pixels[off + 1], pixels[off + 2]]);
        }

        // Median-cut quantization
        const paletteColors = medianCut(samples, 256);

        // Build flat palette (256 entries × 3 channels)
        const palette = new Uint8Array(256 * 3);
        for (let i = 0; i < paletteColors.length && i < 256; i++) {
            palette[i * 3] = paletteColors[i][0];
            palette[i * 3 + 1] = paletteColors[i][1];
            palette[i * 3 + 2] = paletteColors[i][2];
        }

        // Map each pixel to nearest palette index
        const indexedPixels = new Uint8Array(numPixels);
        for (let i = 0; i < numPixels; i++) {
            const off = i * 4;
            const r = pixels[off], g = pixels[off + 1], b = pixels[off + 2];
            indexedPixels[i] = findNearest(r, g, b, paletteColors);
        }

        return { indexedPixels, palette };
    }

    function medianCut(samples, maxColors) {
        if (samples.length === 0) {
            const result = [];
            for (let i = 0; i < maxColors; i++) result.push([0, 0, 0]);
            return result;
        }

        let buckets = [samples];

        while (buckets.length < maxColors) {
            // Find the bucket with the largest range in any channel
            let bestIdx = 0;
            let bestRange = -1;
            let bestChannel = 0;

            for (let bi = 0; bi < buckets.length; bi++) {
                const b = buckets[bi];
                if (b.length < 2) continue;
                for (let ch = 0; ch < 3; ch++) {
                    let lo = 255, hi = 0;
                    for (const px of b) {
                        if (px[ch] < lo) lo = px[ch];
                        if (px[ch] > hi) hi = px[ch];
                    }
                    const range = hi - lo;
                    if (range > bestRange) {
                        bestRange = range;
                        bestIdx = bi;
                        bestChannel = ch;
                    }
                }
            }

            if (bestRange <= 0) break;

            const bucket = buckets[bestIdx];
            bucket.sort((a, b) => a[bestChannel] - b[bestChannel]);
            const mid = bucket.length >> 1;
            buckets.splice(bestIdx, 1, bucket.slice(0, mid), bucket.slice(mid));
        }

        // Average each bucket to get final colors
        return buckets.map(bucket => {
            if (bucket.length === 0) return [0, 0, 0];
            let r = 0, g = 0, b = 0;
            for (const px of bucket) { r += px[0]; g += px[1]; b += px[2]; }
            const n = bucket.length;
            return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
        });
    }

    function findNearest(r, g, b, palette) {
        let bestDist = Infinity;
        let bestIdx = 0;
        for (let i = 0; i < palette.length; i++) {
            const dr = r - palette[i][0];
            const dg = g - palette[i][1];
            const db = b - palette[i][2];
            const dist = dr * dr + dg * dg + db * db;
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
                if (dist === 0) break;
            }
        }
        return bestIdx;
    }

    /**
     * LZW encoder for GIF. Compresses indexed pixel data.
     */
    function lzwEncode(indexedPixels, colorDepth) {
        const minCodeSize = Math.max(2, colorDepth);
        const clearCode = 1 << minCodeSize;
        const eoiCode = clearCode + 1;

        const output = [];
        output.push(minCodeSize);

        let codeSize = minCodeSize + 1;
        let nextCode = eoiCode + 1;
        const maxCodeLimit = 4096;

        // Build initial dictionary
        const dict = new Map();
        for (let i = 0; i < clearCode; i++) {
            dict.set(String(i), i);
        }

        // Sub-block buffer
        let subBlock = [];
        let blockBits = 0;
        let blockBuf = 0;

        function writeBits(code, size) {
            blockBuf |= (code << blockBits);
            blockBits += size;
            while (blockBits >= 8) {
                subBlock.push(blockBuf & 0xFF);
                blockBuf >>= 8;
                blockBits -= 8;
                if (subBlock.length === 255) {
                    output.push(subBlock.length);
                    for (const b of subBlock) output.push(b);
                    subBlock = [];
                }
            }
        }

        // Start with clear code
        writeBits(clearCode, codeSize);

        let current = String(indexedPixels[0]);

        for (let i = 1; i < indexedPixels.length; i++) {
            const next = String(indexedPixels[i]);
            const combined = current + ',' + next;

            if (dict.has(combined)) {
                current = combined;
            } else {
                writeBits(dict.get(current), codeSize);

                if (nextCode < maxCodeLimit) {
                    dict.set(combined, nextCode++);
                    if (nextCode > (1 << codeSize) && codeSize < 12) {
                        codeSize++;
                    }
                } else {
                    // Reset dictionary
                    writeBits(clearCode, codeSize);
                    dict.clear();
                    for (let j = 0; j < clearCode; j++) {
                        dict.set(String(j), j);
                    }
                    nextCode = eoiCode + 1;
                    codeSize = minCodeSize + 1;
                }

                current = next;
            }
        }

        // Write remaining
        writeBits(dict.get(current), codeSize);
        writeBits(eoiCode, codeSize);

        // Flush remaining bits
        if (blockBits > 0) {
            subBlock.push(blockBuf & 0xFF);
        }
        if (subBlock.length > 0) {
            output.push(subBlock.length);
            for (const b of subBlock) output.push(b);
        }

        // Block terminator
        output.push(0);

        return new Uint8Array(output);
    }

    /**
     * Encodes multiple frames into an animated GIF89a.
     * @param {ImageData[]} frames - Array of canvas ImageData objects
     * @param {number} width
     * @param {number} height
     * @param {number} delay - Frame delay in 1/100ths of a second
     * @returns {Blob}
     */
    function encodeAnimatedGif(frames, width, height, delay) {
        const parts = [];

        function writeBytes(arr) {
            parts.push(new Uint8Array(arr));
        }

        function writeString(s) {
            const arr = [];
            for (let i = 0; i < s.length; i++) arr.push(s.charCodeAt(i));
            parts.push(new Uint8Array(arr));
        }

        function uint16LE(val) {
            return [val & 0xFF, (val >> 8) & 0xFF];
        }

        // ── Header ──
        writeString('GIF89a');

        // ── Logical Screen Descriptor ──
        const colorDepth = 8;
        const colorTableSize = 256;
        const gctFlag = 0; // No global color table; each frame has local
        const packed = (gctFlag << 7) | ((colorDepth - 1) << 4) | (0); // no GCT
        writeBytes([...uint16LE(width), ...uint16LE(height), packed, 0, 0]);

        // ── Netscape Looping Extension (infinite loop) ──
        writeBytes([0x21, 0xFF, 0x0B]); // Extension + App block
        writeString('NETSCAPE2.0');
        writeBytes([0x03, 0x01, ...uint16LE(0), 0x00]); // sub-block: loop count=0 (infinite)

        // ── Frames ──
        for (let fi = 0; fi < frames.length; fi++) {
            const { indexedPixels, palette } = quantizeFrame(frames[fi]);

            // Graphic Control Extension
            writeBytes([
                0x21, 0xF9, 0x04,       // Extension introducer, GCE label, block size
                0x00,                     // No disposal, no transparency
                ...uint16LE(delay),       // Delay
                0x00,                     // No transparent color
                0x00                      // Block terminator
            ]);

            // Image Descriptor (with local color table)
            const lctPacked = 0x80 | (colorDepth - 1); // local color table, 256 entries
            writeBytes([
                0x2C,                     // Image separator
                ...uint16LE(0),           // Left
                ...uint16LE(0),           // Top
                ...uint16LE(width),
                ...uint16LE(height),
                lctPacked
            ]);

            // Local Color Table (256 * RGB)
            writeBytes(palette);

            // LZW compressed data
            const compressed = lzwEncode(indexedPixels, colorDepth);
            writeBytes(compressed);
        }

        // ── Trailer ──
        writeBytes([0x3B]);

        return new Blob(parts, { type: 'image/gif' });
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
     * Downloads a file from a URL directly.
     */
    async function downloadFromUrl(url, filename) {
        try {
            const response = await fetch(url, { mode: 'cors' });
            if (!response.ok) throw new Error('Download failed');
            const blob = await response.blob();
            generateDownloadLink(blob, filename);
            return true;
        } catch {
            // Fallback: open in new tab
            window.open(url, '_blank');
            return false;
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

            showToast('Converting to GIF... this may take a moment.', 'info');
            try {
                const gifBlob = await convertVideoToGif(currentMediaData.mp4Url);
                generateDownloadLink(gifBlob, `twitter-gif-${currentMediaData.tweetId}.gif`);
                showToast('GIF downloaded successfully!', 'success');
            } catch (err) {
                showToast('GIF conversion failed. Try downloading as MP4 instead.', 'error');
                console.error('GIF conversion error:', err);
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

            showToast('Starting MP4 download...', 'info');
            const success = await downloadFromUrl(
                currentMediaData.mp4Url,
                `twitter-video-${currentMediaData.tweetId}.mp4`
            );
            if (success) showToast('MP4 downloaded!', 'success');
        },

        /**
         * Download as WebM
         */
        async downloadWebm() {
            if (!currentMediaData?.mp4Url) {
                showToast('No media loaded. Paste a URL first!', 'error');
                return;
            }

            showToast('Starting WebM download...', 'info');
            const success = await downloadFromUrl(
                currentMediaData.mp4Url,
                `twitter-video-${currentMediaData.tweetId}.webm`
            );
            if (success) showToast('WebM downloaded!', 'success');
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
        document.getElementById('download-webm-btn')?.addEventListener('click', () => twitterGifController.downloadWebm());

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
