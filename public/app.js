// =====================================================================
// 🔒 安全网络拦截代理器 (核心防盗防复制设计)
// =====================================================================
(function() {
    const originalFetch = window.fetch;
    window._originalFetch = originalFetch; // 保留原始引用方便非代理状态下使用

    window.fetch = async function(url, options) {
        // 1. 如果是本地资源（如 styles.css、/api/config 等）、局域网 IP 或 data URL，直接放行
        if (typeof url === 'string') {
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                return originalFetch(url, options);
            }
            if (url.includes(window.location.host)) {
                return originalFetch(url, options);
            }
            if (url.startsWith('data:')) {
                return originalFetch(url, options);
            }
        }

        // 2. 如果是通过 file:// 协议直接双击打开（如拷贝到家里的电脑），则直接向官方 API 发送请求
        if (window.location.protocol === 'file:' || window.location.hostname === '') {
            return originalFetch(url, options);
        }

        // 3. 工作模式下：将所有外部 API 请求转发给安全的本地后端进行 Token 注入
        const headers = new Headers(options?.headers || {});
        headers.set('X-Target-URL', url);

        const proxyOptions = {
            ...options,
            headers: headers
        };

        try {
            return await originalFetch('/api/proxy', proxyOptions);
        } catch (e) {
            console.warn('⚠️ 本地代理服务请求失败，正在尝试直接连接官方接口:', e);
            return originalFetch(url, options);
        }
    };

    // 初始化时检测后端密钥配置
    async function checkBackendConfig() {
        try {
            const resp = await originalFetch('/api/config');
            if (resp.ok) {
                const config = await resp.json();
                if (config.hasBananaToken) {
                    const tokenInput = document.getElementById('token');
                    if (tokenInput) {
                        tokenInput.value = '********';
                        tokenInput.disabled = true;
                        tokenInput.type = 'password';
                        tokenInput.placeholder = '🔒 密钥已由本地安全后端托管 (同事不可见)';
                        const toggle = tokenInput.nextElementSibling;
                        if (toggle && toggle.classList.contains('token-toggle')) {
                            toggle.style.display = 'none';
                        }
                    }
                }
                if (config.hasModelScopeToken) {
                    const msInput = document.getElementById('modelscopeToken');
                    if (msInput) {
                        msInput.value = '********';
                        msInput.disabled = true;
                        msInput.type = 'password';
                        msInput.placeholder = '🔒 密钥已由本地安全后端托管 (同事不可见)';
                        const toggle = msInput.nextElementSibling;
                        if (toggle && toggle.classList.contains('token-toggle')) {
                            toggle.style.display = 'none';
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('🔔 未检测到本地安全后端，使用标准直连模式。', e);
        }
    }

    // 在页面加载完毕后运行密钥检测
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkBackendConfig);
    } else {
        checkBackendConfig();
    }
})();

let uploadedFiles = [];

// --- 并发队列相关 ---
let taskQueue = [];
let runningTasks = new Map();
let failedTasks = new Map();
let taskIdCounter = 0;
let maxParallel = 9;
let retryLimit = 1;

// --- 卡片虚拟滚动观察器 ---
let cardObserver = null;

function initCardObserver() {
    if (cardObserver) return;
    
    cardObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const card = entry.target;
            if (entry.isIntersecting) {
                card.classList.remove('card-hidden');
            } else {
                card.classList.add('card-hidden');
            }
        });
    }, {
        rootMargin: '300px',
        threshold: 0
    });
}

// --- 数据库相关 (IndexedDB) ---
const DB_NAME = "BananaProDB_v2"; // 全新数据库名，避开旧库损坏状态
const DB_VERSION = 1; // 全新数据库从版本1开始
const STORE_NAME = "images";
const CHAT_STORE_NAME = "chat_sessions";
const CHAT_DB_KEY = "sessions";
const CHAT_LOCALSTORAGE_KEY = "loris_chat_sessions_v2"; // 同步换key，避免旧数据干扰
let db;
let initDbPromise = null;

// =====================================================================
// 🔌 全局存储自适应引擎选择器 (Storage Adapter)
// =====================================================================
const StorageAdapter = {
    mode: 'local', // 'local' (IndexedDB) 或 'server' (Node.js API)
    storagePath: '', // 本地磁盘路径（仅在 server 模式下有效）
    
    async init() {
        try {
            // 向本地后端服务发送一次超轻量的状态嗅探请求
            const res = await fetch('/api/status');
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'ok') {
                    this.mode = 'server';
                    this.storagePath = data.storagePath;
                    debugLog(`🔌 [StorageAdapter]: 成功连接本地服务器落盘引擎! 存储路径: ${this.storagePath}`);
                    
                    const container = document.getElementById('localStoragePathContainer');
                    const input = document.getElementById('localStoragePathInput');
                    const status = document.getElementById('localStoragePathStatus');
                    if (container) container.style.display = 'block';
                    if (input) input.value = this.storagePath;
                    if (status) status.textContent = `本地物理落盘目录: ${this.storagePath}`;
                    return;
                }
            }
        } catch (_) {}
        this.mode = 'local';
        debugLog("🔌 [StorageAdapter]: 未检测到本地服务器，自适应降级至浏览器 IndexedDB 本地数据库存储。");
        
        const container = document.getElementById('localStoragePathContainer');
        if (container) container.style.display = 'none';
    },
    
    isServer() {
        return this.mode === 'server';
    }
};

// 动态修改本地物理磁盘存储路径
async function updateStoragePath(newPath) {
    if (!StorageAdapter.isServer()) return;
    try {
        const res = await fetch('/api/storage-path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storagePath: newPath })
        });
        const data = await res.json();
        if (data.success) {
            StorageAdapter.storagePath = data.storagePath;
            const statusEl = document.getElementById('localStoragePathStatus');
            if (statusEl) {
                statusEl.textContent = `路径更新成功！本地物理落盘目录: ${data.storagePath}`;
                statusEl.style.color = '#10b981';
            }
            showToast('存储路径更新成功');
        } else {
            const statusEl = document.getElementById('localStoragePathStatus');
            if (statusEl) {
                statusEl.textContent = `路径更新失败: ${data.message}`;
                statusEl.style.color = '#ef4444';
            }
        }
    } catch (e) {
        console.error('❌ 更新本地物理存储路径失败:', e);
        showToast('更新物理路径请求失败');
    }
}

// 获取当前活跃的功能 Tab 模式 (常规: single / 套图: suite / 对话: chat)
function getActivePageMode() {
    if (document.getElementById('pageTabChat')?.classList.contains('active')) {
        return 'chat';
    }
    if (document.getElementById('pageTabSuite')?.classList.contains('active')) {
        return 'suite';
    }
    return 'single';
}

// 首次加载时清理旧的损坏数据库（一次性）
try { indexedDB.deleteDatabase("BananaProDB"); } catch (_) {}

// --- 图片缓存独立数据库 ---
const IMAGE_CACHE_DB_NAME = "BananaProImageCache";
const IMAGE_CACHE_DB_VERSION = 1;
const CHAT_IMAGE_CACHE_STORE = "chat_image_cache";
const CHAT_IMAGE_CACHE_MAX = 15;           // AI回传：原图淘汰的条目阈值
const CACHE_SIZE_WARN = 460 * 1024 * 1024; // 缓存接近上限警告（base64数据量）
const CACHE_SIZE_MAX = 500 * 1024 * 1024;  // 缓存极端安全线（base64数据量）
const USER_ORIGINAL_MAX = 100 * 1024 * 1024; // 用户上传：原图总量上限
let _lastCacheWarnToast = 0; // 防抖：警告toast时间戳
// ========== 卡片文件引用（替代 window[cardId_files]，避免内存泄漏） ==========
const _cardFilesMap = new Map(); // cardId → File[]
function setCardFiles(cardId, files) { _cardFilesMap.set(cardId, files); }
function getCardFiles(cardId) { return _cardFilesMap.get(cardId) || null; }
function deleteCardFiles(cardId) { _cardFilesMap.delete(cardId); }
// ========== 图片缓存内存索引（避免 getAll() 读取全部缓存记录） ==========
// 每条记录只记 key + 大小 + 时间戳，内存占用极小
const _cacheIndex = new Map(); // url/key → { thumbLen, origLen, ts, kind, hasOrig }
let _cacheIndexReady = false;
let _cacheIndexInitPromise = null;

function _initCacheIndex(cacheDb) {
    if (_cacheIndexReady) return Promise.resolve();
    if (_cacheIndexInitPromise) return _cacheIndexInitPromise;
    _cacheIndexInitPromise = new Promise((resolve) => {
        try {
            const tx = cacheDb.transaction([CHAT_IMAGE_CACHE_STORE], 'readonly');
            const req = tx.objectStore(CHAT_IMAGE_CACHE_STORE).openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const v = cursor.value;
                    _cacheIndex.set(v.url || cursor.key, {
                        thumbLen: (v.thumbnail || '').length,
                        origLen: (v.original || '').length,
                        ts: v.timestamp || 0,
                        kind: getChatImageCacheKind(v),
                        hasOrig: !!v.original
                    });
                    cursor.continue();
                } else {
                    _cacheIndexReady = true;
                    resolve();
                }
            };
            req.onerror = () => { _cacheIndexReady = true; resolve(); };
        } catch (_) { _cacheIndexReady = true; resolve(); }
    });
    return _cacheIndexInitPromise;
}

function _cacheIndexSet(url, thumb, orig, kind) {
    _cacheIndex.set(url, {
        thumbLen: (thumb || '').length,
        origLen: (orig || '').length,
        ts: Date.now(),
        kind: kind || 'ai',
        hasOrig: !!orig
    });
}

function _cacheIndexDelete(url) {
    _cacheIndex.delete(url);
}

function _cacheIndexUpdate(url, patch) {
    const e = _cacheIndex.get(url);
    if (e) Object.assign(e, patch);
}

function _cacheIndexTotalSize() {
    let total = 0;
    for (const e of _cacheIndex.values()) total += e.thumbLen + e.origLen;
    return total;
}

// ========== 消息图片缓存精确清理 ==========
// 从消息数组中收集所有图片的缓存 key（用于删除时精确释放）
function _collectImageKeysFromMessages(messages) {
    const keys = new Set();
    if (!Array.isArray(messages)) return keys;
    for (const msg of messages) {
        // 1. 收集普通消息中的图片
        if (Array.isArray(msg.images)) {
            for (const img of msg.images) {
                if (!img) continue;
                // cacheKey 是 IndexedDB 中的主键
                if (img.cacheKey) keys.add(img.cacheKey);
                // data/previewData/url 可能是 _apiImageCache 的 key
                const src = img.previewData || img.data || img.url || '';
                if (src) keys.add(src);
            }
        }
        // 2. 收集正在生成或历史生图任务中的图片（防遗漏）
        if (msg.imageTask && Array.isArray(msg.imageTask.images)) {
            for (const img of msg.imageTask.images) {
                if (!img) continue;
                if (img.cacheKey) keys.add(img.cacheKey);
                const src = img.previewData || img.data || img.url || '';
                if (src) keys.add(src);
            }
        }
    }
    return keys;
}

// 从三个缓存中移除指定 key 集合（只有当 key 不再被任何其他活跃对话引用时，才物理删除）
async function _removeImageCacheKeys(keys) {
    if (!keys || keys.size === 0) return;

    // 收集所有其他活跃对话正在引用的所有图片 key（避免误删复用、共享图片缓存）
    const activeKeysInUse = new Set();
    for (const chat of chatConversations) {
        const otherKeys = _collectImageKeysFromMessages(chat.messages);
        for (const k of otherKeys) {
            activeKeysInUse.add(k);
        }
    }

    // 只有不被任何活跃对话引用的 key，才安全物理删除
    const safeToDeleteKeys = new Set();
    for (const key of keys) {
        if (!activeKeysInUse.has(key)) {
            safeToDeleteKeys.add(key);
        }
    }

    if (safeToDeleteKeys.size === 0) return;

    // 1. 内存缓存
    for (const key of safeToDeleteKeys) {
        _apiImageCache.delete(key);
        _cacheIndex.delete(key);
    }
    // 2. IndexedDB 图片缓存
    let cacheDb;
    try { cacheDb = await initImageCacheDB(); } catch (_) { return; }
    if (!cacheDb) return;
    try {
        const tx = cacheDb.transaction([CHAT_IMAGE_CACHE_STORE], 'readwrite');
        const store = tx.objectStore(CHAT_IMAGE_CACHE_STORE);
        for (const key of safeToDeleteKeys) {
            try { store.delete(key); } catch (_) {}
        }
    } catch (_) {}
}

async function cleanupOrphanImageCache() {
    let cacheDb;
    try { cacheDb = await initImageCacheDB(); } catch (_) { return; }
    if (!cacheDb) return;
    try { await _initCacheIndex(cacheDb); } catch (_) { return; }
    if (_cacheIndex.size === 0) return;

    // 收集所有对话中活跃的图片 key
    const activeKeys = new Set();
    for (const chat of chatConversations) {
        for (const key of _collectImageKeysFromMessages(chat.messages)) activeKeys.add(key);
    }
    // 收集需要删除的孤儿 key
    const orphanKeys = new Set();
    for (const key of _cacheIndex.keys()) {
        if (!activeKeys.has(key)) orphanKeys.add(key);
    }
    if (orphanKeys.size === 0) return;
    debugLog(`[缓存清理] 发现 ${orphanKeys.size} 个孤儿缓存条目，开始清理...`);
    await _removeImageCacheKeys(orphanKeys);
    debugLog(`[缓存清理] 完成，释放 ${orphanKeys.size} 条`);
}

let imageCacheDb = null;
let initImageCacheDbPromise = null;

// --- 历史记录分页加载相关 ---
// 剥离历史记录中的大字段（Base64 图片等），只保留轻量元数据用于侧边栏展示
function stripHeavyFields(item) {
    if (!item) return item;
    const light = Object.assign({}, item);
    delete light.image;       // 原图 Base64（几 MB ~ 十几 MB）
    delete light.fileData;    // 上传文件 Base64 数组
    delete light.firstImage;  // 套图首图 Base64
    delete light.rawResponse; // API 原始响应文本
    return light;
}

// 从 IndexedDB 按 id 异步加载单条历史记录的完整数据（含原图）
async function getHistoryItemById(id) {
    if (StorageAdapter.isServer()) {
        try {
            const reqClientId = localStorage.getItem('clientId') || '';
            const res = await fetch(`/api/history?clientId=${encodeURIComponent(reqClientId)}`);
            const history = await res.json();
            const item = history.find(h => String(h.id) === String(id));
            return item || null;
        } catch (e) {
            console.error('❌ StorageAdapter getHistoryItemById 失败:', e);
        }
    }

    return new Promise((resolve) => {
        if (!db) return resolve(null);
        try {
            const tx = db.transaction([STORE_NAME], 'readonly');
            const req = tx.objectStore(STORE_NAME).get(Number(id));
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        } catch (_) { resolve(null); }
    });
}

let historyPageSize = 7;
let historyCurrentPage = 1;
let historyTotalPages = 1;
let historyAllItems = [];
let historyIsLoading = false;
let suiteArchiveDirectoryHandle = null;
let suiteArchiveDirectoryPermission = 'none';
let suiteArchiveDirectoryName = '';
let suiteArchiveConfigDb = null;

function getDefaultDrawApiBase() {
    return ['https://', 'grsai', '.dakka', '.com.cn'].join('');
}

function getDefaultChatApiBase() {
    return ['https://', 'grsai', 'api', '.com'].join('');
}

function initDB() {
    if (db) return Promise.resolve(db);
    if (initDbPromise) return initDbPromise;
    initDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (e) => {
            const idb = e.target.result;
            if (!idb.objectStoreNames.contains(STORE_NAME)) {
                idb.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
            }
            if (!idb.objectStoreNames.contains(CHAT_STORE_NAME)) {
                idb.createObjectStore(CHAT_STORE_NAME, { keyPath: "key" });
            }
        };

        request.onsuccess = (e) => {
            db = e.target.result;
            initDbPromise = null;
            try {
                loadHistoryToSidebar();
            } catch (_) {}
            resolve(db);
        };

        request.onerror = (e) => {
            initDbPromise = null;
            const errName = e.target.error?.name;
            if (errName === 'VersionError') {
                // 版本不兼容：提示用户决定是否重置，而非静默删库
                const shouldReset = confirm(
                    '数据库版本不兼容（可能使用了旧版本页面）。\n\n' +
                    '点击"确定"：重置数据库（所有历史记录、对话、缓存将丢失）\n' +
                    '点击"取消"：不加载数据库（页面功能受限）'
                );
                if (shouldReset) {
                    const delReq = indexedDB.deleteDatabase(DB_NAME);
                    delReq.onsuccess = () => {
                        initDbPromise = null;
                        db = null;
                        initDB().then(resolve).catch(reject);
                    };
                    delReq.onerror = () => reject(new Error("DB delete failed"));
                } else {
                    reject(new Error("用户取消了数据库重置"));
                }
            } else {
                reject(new Error("DB Error"));
            }
        };

        request.onblocked = () => {
            console.warn("IndexedDB 升级被阻塞，请关闭其他同站点标签页后刷新");
        };
    });
    return initDbPromise;
}

// --- 图片缓存独立数据库 ---
function initImageCacheDB() {
    if (imageCacheDb) return Promise.resolve(imageCacheDb);
    if (initImageCacheDbPromise) return initImageCacheDbPromise;
    initImageCacheDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(IMAGE_CACHE_DB_NAME, IMAGE_CACHE_DB_VERSION);

        request.onupgradeneeded = (e) => {
            const idb = e.target.result;
            if (!idb.objectStoreNames.contains(CHAT_IMAGE_CACHE_STORE)) {
                idb.createObjectStore(CHAT_IMAGE_CACHE_STORE, { keyPath: "url" });
            }
        };

        request.onsuccess = (e) => {
            imageCacheDb = e.target.result;
            initImageCacheDbPromise = null;
            resolve(imageCacheDb);
        };

        request.onerror = (e) => {
            initImageCacheDbPromise = null;
            reject(new Error("ImageCacheDB Error"));
        };
    });
    return initImageCacheDbPromise;
}

// 生成历史记录缩略图（小尺寸 JPEG，用于侧边栏展示，避免内存中常驻大图）
function generateHistoryThumbnail(dataUrl, maxSize = 80) {
    return new Promise((resolve) => {
        try {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
                const w = Math.round(img.width * scale);
                const h = Math.round(img.height * scale);
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.6));
            };
            img.onerror = () => resolve(null);
            img.src = dataUrl;
        } catch (_) { resolve(null); }
    });
}

function saveToDB(data, promptText, type = 'image', files = null, metadata = null) {
    if (!db) return Promise.resolve(null);

    const item = {
        type: type,
        prompt: promptText,
        timestamp: new Date().getTime()
    };

    if (type === 'image') {
        item.image = data;
    } else {
        item.result = data;
    }
    
    if (metadata) {
        item.aspectRatio = metadata.aspectRatio;
        item.imageSize = metadata.imageSize;
        item.targetResolution = metadata.targetResolution;
        item.model = metadata.model;
        item.actualResolution = metadata.actualResolution;
        if (metadata.taskMode) {
            item.taskMode = metadata.taskMode;
        }
    }

    return new Promise((resolve) => {
        const doSave = () => {
            // 保存参考图文件数据
            if (files && files.length > 0) {
                const filePromises = files.map(file => {
                    return new Promise((res) => {
                        const r = new FileReader();
                        r.onload = (ev) => res({
                            name: file.name,
                            type: file.type,
                            size: file.size,
                            data: ev.target.result
                        });
                        r.readAsDataURL(file);
                    });
                });
                
                Promise.all(filePromises).then(fileDataArray => {
                    item.fileData = fileDataArray;
                    storeItem(item, resolve);
                });
            } else {
                storeItem(item, resolve);
            }
        };

        // 为图片类型生成缩略图（仅对 data: URL 生成，网络 URL 本身不大）
        if (type === 'image' && data && typeof data === 'string' && data.startsWith('data:')) {
            generateHistoryThumbnail(data).then(thumb => {
                if (thumb) item.thumbnail = thumb;
                doSave();
            });
        } else {
            doSave();
        }
    });
}

// 保存套图历史记录
function saveSuiteToDB(suiteData) {
    if (!db) return Promise.resolve(null);

    const item = {
        type: 'suite',
        prompt: suiteData.prompt || '套图批量生成',
        timestamp: new Date().getTime(),
        keywords: suiteData.keywords || [],
        images: suiteData.images || [],
        model: suiteData.model || '',
        vlModel: suiteData.vlModel || '',
        ratio: suiteData.ratio || '1:1',
        size: suiteData.size || '1K',
        rule: suiteData.rule || '',
        count: suiteData.count || 0,
        rawResponse: suiteData.rawResponse || '',
        status: suiteData.status || '',
        taskId: suiteData.taskId || ''
    };

    // 保存参考图文件数据
    if (suiteData.fileData && suiteData.fileData.length > 0) {
        item.fileData = suiteData.fileData;
        item.firstImage = suiteData.firstImage || suiteData.fileData[0]?.data;
    }

    return new Promise((resolve) => {
        const doSave = () => {
            storeItem(item, (savedId) => {
                // 保存完整套图（含图片）后，不再清理同批次仅关键词的历史记录
                // 用户需要保留关键词生成和图片生成两个独立的历史记录
                if (savedId && Array.isArray(item.images) && item.images.length > 0) {
                    if (typeof loadHistory === 'function') loadHistory();
                    resolve(savedId);
                    return;
                }
                if (typeof loadHistory === 'function') loadHistory();
                resolve(savedId);
            });
        };

        // 为套图生成缩略图（取 firstImage 或第一张 fileData）
        const thumbSrc = item.firstImage || (item.fileData && item.fileData[0]?.data);
        if (thumbSrc && typeof thumbSrc === 'string' && thumbSrc.startsWith('data:')) {
            generateHistoryThumbnail(thumbSrc).then(thumb => {
                if (thumb) item.thumbnail = thumb;
                doSave();
            });
        } else {
            doSave();
        }
    });
}

function cleanupRedundantSuiteKeywordOnlyHistory(savedId, savedItem) {
    if (!db || !savedId || !savedItem) return Promise.resolve();

    const normalizeKeywords = (arr) => (Array.isArray(arr) ? arr : [])
        .map(k => String(k || '').trim())
        .filter(Boolean);

    const savedKeywords = normalizeKeywords(savedItem.keywords);
    const savedRule = String(savedItem.rule || '').trim();
    const savedFirstImage = String(savedItem.firstImage || '');

    return new Promise((resolve) => {
        try {
            const readTx = db.transaction([STORE_NAME], 'readonly');
            const readReq = readTx.objectStore(STORE_NAME).getAll();

            readReq.onsuccess = () => {
                const all = readReq.result || [];
                const toDeleteIds = all
                    .filter((it) => {
                        if (!it || it.id === savedId || it.type !== 'suite') return false;
                        const hasNoImages = !Array.isArray(it.images) || it.images.length === 0;
                        if (!hasNoImages) return false;

                        const sameKeywords = JSON.stringify(normalizeKeywords(it.keywords)) === JSON.stringify(savedKeywords);
                        const sameRule = String(it.rule || '').trim() === savedRule;
                        const sameFirstImage = savedFirstImage && it.firstImage
                            ? String(it.firstImage) === savedFirstImage
                            : true;

                        return sameKeywords && sameRule && sameFirstImage;
                    })
                    .map(it => it.id);

                if (toDeleteIds.length === 0) {
                    resolve();
                    return;
                }

                const delTx = db.transaction([STORE_NAME], 'readwrite');
                const store = delTx.objectStore(STORE_NAME);
                toDeleteIds.forEach(id => store.delete(id));

                delTx.oncomplete = () => {
                    loadHistoryPage(historyCurrentPage);
                    resolve();
                };
                delTx.onerror = () => resolve();
            };

            readReq.onerror = () => resolve();
        } catch (_) {
            resolve();
        }
    });
}

async function storeItem(item, callback) {
    if (StorageAdapter.isServer()) {
        try {
            // 性能优化：通过任务的自身属性（item.type/item.taskMode）决定具体的保存路径，拒绝依靠当前 UI 上切了什么 Tab
            const saveMode = item.mode || item.taskMode || (item.type === 'suite' ? 'suite' : (item.type === 'recognition' ? 'recognition' : 'single'));
            let chatTitle = '';
            
            if (saveMode === 'chat' && typeof chatConversations !== 'undefined' && typeof currentChatId !== 'undefined') {
                const activeChat = chatConversations.find(c => String(c.id) === String(currentChatId));
                if (activeChat) {
                    chatTitle = activeChat.title;
                }
            }
            
            let imageToSave = null;
            if (item.image && typeof item.image === 'string' && item.image.startsWith('data:image/')) {
                imageToSave = item.image;
            } else if (item.url && typeof item.url === 'string' && item.url.startsWith('data:image/')) {
                imageToSave = item.url;
            } else if (item.result && typeof item.result === 'string' && item.result.startsWith('data:image/')) {
                imageToSave = item.result;
            }

            const recordToSave = {
                ...item, // 100% 无损拷贝原始数据对象的所有深层高维元数据字段（如 aspectRatio, targetResolution, actualResolution 等）
                id: item.id || Date.now(),
                type: item.type || 'image',
                prompt: item.prompt || '',
                negativePrompt: item.negativePrompt || '',
                model: item.model || '',
                ratio: item.ratio || '1:1',
                size: item.size || '1K',
                width: item.width || 1024,
                height: item.height || 1024,
                seed: item.seed || -1,
                steps: item.steps || 20,
                scale: item.scale || 7,
                timestamp: item.timestamp || Date.now(),
                clientId: localStorage.getItem('clientId') || '',
                username: localStorage.getItem('username') || '',
                // 三层归口落盘所需的字段：兼容常规生图 item.image 和 AI回传/聊天结果 item.result、item.url
                mode: saveMode,
                chatName: chatTitle,
                imageData: imageToSave
            };
            
            // 如果是套图模式，同步拷贝套图专属的结构字段
            if (saveMode === 'suite') {
                recordToSave.keywords = item.keywords || [];
                recordToSave.rule = item.rule || '';
                recordToSave.images = item.images || [];
                recordToSave.firstImage = item.firstImage || '';
                recordToSave.type = 'suite';
            }
            
            const res = await fetch('/api/save-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(recordToSave)
            });
            const data = await res.json();
            if (data.success) {
                const serverRecord = data.record || recordToSave;
                item.url = data.url; // 将前端原有的内存 Base64 替换为物理落盘相对路径 /output/...
                item.image = '';     // 物理落盘成功后，立即彻底清空前端庞大的 Base64 内存占用，秒级减负！
                item.result = '';
                item.id = serverRecord.id;
                item.thumbnail = serverRecord.thumbnail || serverRecord.url;
                item.localFolderName = serverRecord.localFolderName;
                item.images = serverRecord.images;
                item.firstImage = serverRecord.firstImage;
                
                // 物理落盘成功后，也将其写进前端的本地离线数据库，保持两端 100% 同步
                if (db) {
                    try {
                        const tx = db.transaction([STORE_NAME], "readwrite");
                        tx.objectStore(STORE_NAME).put(serverRecord);
                    } catch (_) {}
                }
                
                loadHistoryPage(1);
                if (callback) callback(item.id);
                return;
            }
        } catch (e) {
            console.error('❌ StorageAdapter 物理存图失败，自适应降级至浏览器 IndexedDB 存储:', e);
        }
    }

    const request = db.transaction([STORE_NAME], "readwrite")
        .objectStore(STORE_NAME)
        .add(item);

    request.onsuccess = (e) => {
        const savedId = e.target.result;
        item.id = savedId;
        // 新记录创建时，重置到第一页并刷新显示，确保用户能看到新记录
        loadHistoryPage(1);
        if (callback) callback(savedId);
    };
    request.onerror = (e) => {
        console.error("Save error", e);
        if (callback) callback(null);
    };
}

// 更新历史记录（用于套图模式逐步更新）
async function updateSuiteHistoryInDB(historyId, updates, callback) {
    if (StorageAdapter.isServer()) {
        try {
            const item = await getHistoryItemById(historyId);
            if (!item) {
                console.warn("History item not found:", historyId);
                return null;
            }
            
            Object.assign(item, updates);
            
            const res = await fetch('/api/save-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item)
            });
            const data = await res.json();
            if (data.success) {
                const serverRecord = data.record || item;
                // 用后端处理物理 URL 后的最终记录更新前端的 item 实例，防止前端继续持有 Base64
                Object.assign(item, serverRecord);
                
                const idx = historyAllItems.findIndex(it => it.id === historyId);
                if (idx !== -1) {
                    historyAllItems[idx] = stripHeavyFields(serverRecord);
                }
                
                // 将最新包含物理相对路径的最终记录同步写进 IndexedDB 本地库
                if (db) {
                    try {
                        const tx = db.transaction([STORE_NAME], "readwrite");
                        tx.objectStore(STORE_NAME).put(serverRecord);
                    } catch (_) {}
                }
                
                if (callback) callback(historyId);
                return historyId;
            }
        } catch (e) {
            console.error('❌ StorageAdapter updateSuiteHistoryInDB 失败:', e);
        }
    }

    if (!db || !historyId) return Promise.resolve(null);

    return new Promise((resolve) => {
        const transaction = db.transaction([STORE_NAME], "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const getRequest = store.get(historyId);
        let updatedItem = null;
        let updatedId = null;

        transaction.oncomplete = () => {
            if (updatedItem && updatedId) {
                const idx = historyAllItems.findIndex(it => it.id === historyId);
                if (idx !== -1) {
                    historyAllItems[idx] = stripHeavyFields(updatedItem);
                }
                if (callback) callback(historyId);
                resolve(updatedId);
            } else {
                resolve(null);
            }
        };
        transaction.onerror = () => {
            console.error("Update transaction error", transaction.error);
            resolve(null);
        };
        transaction.onabort = () => {
            console.error("Update transaction aborted", transaction.error);
            resolve(null);
        };

        getRequest.onsuccess = () => {
            const item = getRequest.result;
            if (!item) {
                console.warn("History item not found:", historyId);
                return;
            }

            // 合并更新
            Object.assign(item, updates);
            updatedItem = item;
            updatedId = historyId;

            // 保存回数据库
            const putRequest = store.put(item);
            putRequest.onerror = () => {
                console.error("Update error", putRequest.error);
            };
        };
        getRequest.onerror = () => {
            console.error("Get error", getRequest.error);
        };
    });
}

function touchSuiteHistoryInDB(historyId, updates, callback) {
    return updateSuiteHistoryInDB(historyId, updates || {}, callback);
}

async function deleteFromDB(id, element) {
    if(!confirm("确定删除这张图片吗？")) return;
    
    if (StorageAdapter.isServer()) {
        try {
            const reqClientId = localStorage.getItem('clientId') || '';
            const res = await fetch(`/api/history?id=${id}&clientId=${encodeURIComponent(reqClientId)}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                if (element) {
                    element.style.transition = 'opacity 0.3s, transform 0.3s';
                    element.style.opacity = '0';
                    element.style.transform = 'scale(0.8)';
                    setTimeout(() => element.remove(), 300);
                }
                loadHistoryPage(historyCurrentPage);
                showToast('已删除');
                return;
            } else {
                alert('⚠️ 删除失败：' + (data.error || '权限不足'));
            }
        } catch (e) {
            console.error('❌ StorageAdapter 删除历史记录失败:', e);
        }
    }

    if (!db) return;
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.delete(id);
    transaction.oncomplete = () => {
        if (element) {
            element.style.transition = 'opacity 0.3s, transform 0.3s';
            element.style.opacity = '0';
            element.style.transform = 'scale(0.8)';
            setTimeout(() => element.remove(), 300);
        }
        loadHistoryPage(historyCurrentPage);
    };
}

// 删除回传卡片（同时删除历史记录）
async function deleteResultCard(btn) {
    if (!confirm("确定删除这张图片吗？")) return;
    
    const card = btn.closest('.result-card');
    if (!card) return;
    
    const historyId = card.dataset.historyId ? card.dataset.historyId : null;
    
    const doDelete = async () => {
        if (StorageAdapter.isServer() && historyId) {
            try {
                const reqClientId = localStorage.getItem('clientId') || '';
                const res = await fetch(`/api/history?id=${historyId}&clientId=${encodeURIComponent(reqClientId)}`, { method: 'DELETE' });
                const data = await res.json();
                if (!data.success) {
                    alert('⚠️ 删除失败：' + (data.error || '权限不足'));
                    return;
                }
                loadHistoryPage(historyCurrentPage);
            } catch (e) {
                console.error('❌ StorageAdapter 删除卡片文件失败:', e);
            }
        } else if (db && historyId && !isNaN(parseInt(historyId))) {
            const transaction = db.transaction([STORE_NAME], "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            store.delete(parseInt(historyId));
            transaction.oncomplete = () => {
                loadHistoryPage(historyCurrentPage);
            };
        }
    };
    
    await doDelete();
    
    // 删除卡片 DOM
    if (card.id) deleteCardFiles(card.id);
    card.style.transition = 'opacity 0.3s, transform 0.3s';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.8)';
    setTimeout(() => card.remove(), 300);
    
    showToast('已删除');
}

async function clearAllHistoryDB() {
    if(!confirm("这将清空所有本地保存的历史记录，且无法恢复！确定吗？")) return;
    
    if (StorageAdapter.isServer()) {
        try {
            const reqClientId = localStorage.getItem('clientId') || '';
            const res = await fetch(`/api/history?clientId=${encodeURIComponent(reqClientId)}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                historyAllItems = [];
                _cardFilesMap.clear(); // 清理所有卡片文件引用，释放内存
                historyCurrentPage = 1;
                historyTotalPages = 1;
                renderHistoryPage();
                showToast('已成功清空所有历史');
                return;
            } else {
                alert('⚠️ 清空失败：' + (data.error || '服务器拒绝'));
            }
        } catch (e) {
            console.error('❌ StorageAdapter 清空历史失败:', e);
        }
    }

    if (!db) return;
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.clear();
    transaction.oncomplete = () => {
        historyAllItems = [];
        _cardFilesMap.clear(); // 清理所有卡片文件引用，释放内存
        historyCurrentPage = 1;
        historyTotalPages = 1;
        renderHistoryPage();
    };
}

function loadHistoryToSidebar() {
    loadHistoryPage(1);
}

// loadHistory 别名，兼容旧代码调用
const loadHistory = loadHistoryToSidebar;

async function loadHistoryPage(page = historyCurrentPage) {
    const grid = document.getElementById('historyGrid');
    if (!grid) return;

    historyIsLoading = true;
    
    // 性能优化：只有当内存缓存中没有任何记录时，才清空屏幕显示旋转加载动画
    const hasCache = Array.isArray(historyAllItems) && historyAllItems.length > 0;
    if (!hasCache) {
        grid.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-sub);"><i class="fas fa-spinner fa-spin" style="font-size: 24px; margin-bottom: 10px; opacity: 0.5;"></i><p>加载历史记录...</p></div>';
    }

    if (StorageAdapter.isServer()) {
        try {
            const reqClientId = localStorage.getItem('clientId') || '';
            const adminFilterSelect = document.getElementById('adminUserFilter');
            const adminFilterVal = adminFilterSelect ? adminFilterSelect.value : 'all';
            const urlWithParams = `/api/history?clientId=${encodeURIComponent(reqClientId)}&filterClientId=${encodeURIComponent(adminFilterVal)}`;
            
            const res = await fetch(urlWithParams);
            const allServerItems = await res.json();
            const totalCount = allServerItems.length;
            historyTotalPages = Math.ceil(totalCount / historyPageSize) || 1;
            historyCurrentPage = Math.min(Math.max(1, page), historyTotalPages);
            const skipCount = (historyCurrentPage - 1) * historyPageSize;
            const pageItems = allServerItems.slice(skipCount, skipCount + historyPageSize);
            
            historyAllItems = pageItems;
            historyIsLoading = false;
            renderHistoryPageItems(pageItems, totalCount);
            return;
        } catch (e) {
            console.error('❌ StorageAdapter 加载历史失败，降级回本地数据库:', e);
        }
    }

    if (!db) {
        historyIsLoading = false;
        grid.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-sub);"><p>本地数据库未准备就绪</p></div>';
        return;
    }

    const countTx = db.transaction([STORE_NAME], "readonly");
    const countStore = countTx.objectStore(STORE_NAME);
    const countRequest = countStore.count();

    countRequest.onsuccess = () => {
        const totalCount = countRequest.result || 0;
        historyTotalPages = Math.ceil(totalCount / historyPageSize) || 1;
        historyCurrentPage = Math.min(Math.max(1, page), historyTotalPages);

        const skipCount = (historyCurrentPage - 1) * historyPageSize;
        const pageItems = [];
        let skipped = 0;

        const pageTx = db.transaction([STORE_NAME], "readonly");
        const pageStore = pageTx.objectStore(STORE_NAME);
        const request = pageStore.openCursor(null, 'prev');

        request.onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor || pageItems.length >= historyPageSize) {
                historyAllItems = pageItems;
                historyIsLoading = false;
                renderHistoryPageItems(pageItems, totalCount);
                return;
            }

            if (skipped < skipCount) {
                skipped++;
                cursor.continue();
                return;
            }

            pageItems.push(stripHeavyFields(cursor.value));
            cursor.continue();
        };

        request.onerror = () => {
            historyIsLoading = false;
            grid.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-sub);"><p>历史记录加载失败</p></div>';
        };
    };

    countRequest.onerror = () => {
        historyIsLoading = false;
        grid.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-sub);"><p>历史记录加载失败</p></div>';
    };
}

// 渲染指定页的历史记录 - 使用 DocumentFragment 批量添加
function renderHistoryPageItems(itemsToRender, totalCount) {
    const grid = document.getElementById('historyGrid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!totalCount || itemsToRender.length === 0) {
        grid.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-sub);"><i class="fas fa-inbox" style="font-size: 32px; margin-bottom: 10px; opacity: 0.5;"></i><p>暂无历史记录</p></div>';
        return;
    }

    const fragment = document.createDocumentFragment();
    itemsToRender.forEach(item => {
        const div = createHistoryThumbnail(item);
        fragment.appendChild(div);
    });
    grid.appendChild(fragment);

    renderPagination();
}

function renderHistoryPage() {
    loadHistoryPage(historyCurrentPage);
}

// 渲染分页按钮
function renderPagination() {
    const grid = document.getElementById('historyGrid');
    
    const paginationDiv = document.createElement('div');
    paginationDiv.className = 'history-pagination';
    
    // 上一页按钮
    const prevBtn = document.createElement('button');
    prevBtn.className = 'pagination-btn';
    prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
    prevBtn.disabled = historyCurrentPage === 1;
    prevBtn.onclick = () => goToPage(historyCurrentPage - 1);
    paginationDiv.appendChild(prevBtn);
    
    // 页码按钮
    const pageNumbers = getPageNumbers(historyCurrentPage, historyTotalPages);
    pageNumbers.forEach(num => {
        if (num === '...') {
            const ellipsis = document.createElement('span');
            ellipsis.className = 'pagination-ellipsis';
            ellipsis.textContent = '...';
            paginationDiv.appendChild(ellipsis);
        } else {
            const pageBtn = document.createElement('button');
            pageBtn.className = 'pagination-btn' + (num === historyCurrentPage ? ' active' : '');
            pageBtn.textContent = num;
            pageBtn.onclick = () => goToPage(num);
            paginationDiv.appendChild(pageBtn);
        }
    });
    
    // 下一页按钮
    const nextBtn = document.createElement('button');
    nextBtn.className = 'pagination-btn';
    nextBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
    nextBtn.disabled = historyCurrentPage === historyTotalPages;
    nextBtn.onclick = () => goToPage(historyCurrentPage + 1);
    paginationDiv.appendChild(nextBtn);
    
    grid.appendChild(paginationDiv);
}

// 计算要显示的页码
function getPageNumbers(current, total) {
    const pages = [];
    
    if (total <= 7) {
        // 总页数少于7，显示所有页码
        for (let i = 1; i <= total; i++) {
            pages.push(i);
        }
    } else {
        // 总是显示第一页
        pages.push(1);
        
        if (current > 3) {
            pages.push('...');
        }
        
        // 显示当前页附近的页码
        const start = Math.max(2, current - 1);
        const end = Math.min(total - 1, current + 1);
        
        for (let i = start; i <= end; i++) {
            pages.push(i);
        }
        
        if (current < total - 2) {
            pages.push('...');
        }
        
        // 总是显示最后一页
        pages.push(total);
    }
    
    return pages;
}

// 跳转到指定页
function goToPage(page) {
    if (page < 1 || page > historyTotalPages || page === historyCurrentPage) return;
    loadHistoryPage(page);

    const grid = document.getElementById('historyGrid');
    if (grid) grid.scrollTop = 0;
}

// --- 初始化 ---
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);

    setupEventListeners();
    initCardObserver();

    const drawApiBaseEl = document.getElementById('drawApiBase');
    const chatApiBaseEl = document.getElementById('chatApiBase');
    if (drawApiBaseEl && !drawApiBaseEl.value) drawApiBaseEl.value = getDefaultDrawApiBase();
    if (chatApiBaseEl && !chatApiBaseEl.value) chatApiBaseEl.value = getDefaultChatApiBase();
    
    const savedToken = localStorage.getItem('banana_token');
    if (savedToken) {
        document.getElementById('token').value = savedToken;
    }
    document.getElementById('token').addEventListener('input', (e) => {
        localStorage.setItem('banana_token', e.target.value.trim());
    });

    // 加载并保存 ModelScope Token
    const savedModelScopeToken = localStorage.getItem('modelscope_token');
    if (savedModelScopeToken) {
        const modelscopeTokenInput = document.getElementById('modelscopeToken');
        if (modelscopeTokenInput) {
            modelscopeTokenInput.value = savedModelScopeToken;
        }
    }
    const modelscopeTokenEl = document.getElementById('modelscopeToken');
    if (modelscopeTokenEl) {
        modelscopeTokenEl.addEventListener('input', (e) => {
            localStorage.setItem('modelscope_token', e.target.value.trim());
        });
    }

    initSuiteArchiveSettings();

    (async () => {
        // 确保 DOM 树完全画完并就绪后再启动核心系统和用户登记
        if (document.readyState === 'loading') {
            await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));
        }
        
        console.log('⚡ [Loirs Startup]: DOM 树渲染就绪，开始自适应初始化队列...');
        try {
            await StorageAdapter.init();
            console.log('⚡ [Loirs Startup]: StorageAdapter 初始化完成，当前运行模式:', StorageAdapter.mode);
            if (StorageAdapter.isServer()) {
                await checkUserRegistration();
                loadHistoryToSidebar();
            } else {
                console.warn('⚡ [Loirs Startup]: 检测到当前处于 IndexedDB 本地离线模式，跳过多用户名字登记。');
            }
        } catch (e) {
            console.error('❌ [Loirs Startup]: 严重错误！StorageAdapter 初始化流程遭遇了未捕获异常:', e);
        }
        try {
            await initDB();
        } catch (e) {
            debugLog("DB init skipped or failed");
        }
    })();
    renderTaskResultNotifications();

    // 全局滚轮事件：在左右空白区域也能滚动 scrollArea
    document.body.addEventListener('wheel', (e) => {
        const scrollArea = document.getElementById('scrollArea');
        if (!scrollArea) return;
        
        // 如果事件目标在 scrollArea 内部，不干预（让它自然滚动）
        if (scrollArea.contains(e.target)) return;
        
        // 如果事件目标在历史记录抽屉内部，不干预（让历史记录自己滚动）
        const historyGrid = document.getElementById('historyGrid');
        if (historyGrid && historyGrid.contains(e.target)) return;
        
        // 如果事件目标在模板弹窗内部，检查是否是可滚动元素
        const templateModalOverlay = document.getElementById('templateModalOverlay');
        if (templateModalOverlay && templateModalOverlay.classList.contains('show')) {
            // 检查是否在模板卡片文本区域内滚动
            const templateItemText = e.target.closest('.template-item-text');
            if (templateItemText && templateItemText.scrollHeight > templateItemText.clientHeight) {
                return; // 让模板卡片文本自己滚动
            }
            // 检查是否在模板列表内滚动
            const templateList = e.target.closest('.template-list');
            if (templateList && templateList.scrollHeight > templateList.clientHeight) {
                return; // 让模板列表自己滚动
            }
        }
        
        // 如果事件目标是可滚动元素（如 textarea），不干预
        const target = e.target;
        if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
            // 检查是否可滚动
            if (target.scrollHeight > target.clientHeight) {
                return; // 让输入框自己滚动
            }
        }
        
        // 如果 scrollArea 没有滚动条，不处理
        if (scrollArea.scrollHeight <= scrollArea.clientHeight) return;
        
        // 阻止默认行为，手动滚动 scrollArea
        e.preventDefault();
        scrollArea.scrollTop += e.deltaY;
    }, { passive: false });

    syncConfigFromUI();
    
    // 初始化模型下拉菜单（根据当前模式显示对应模型）
    const currentMode = document.getElementById('modeSelect').value;
    updateModelDropdownForMode(currentMode);
    
    // 初始化费用显示
    const currentModel = document.getElementById('modelSelect').value;
    updatePriceDisplay(currentModel);

    const historyGridEl = document.getElementById('historyGrid');
    if (historyGridEl) {
        historyGridEl.addEventListener('wheel', (e) => {
            const drawer = document.getElementById('historyDrawer');
            if (!drawer || !drawer.classList.contains('open')) return;
            if (historyGridEl.scrollHeight <= historyGridEl.clientHeight) return;
            e.preventDefault();
            historyGridEl.scrollTop += e.deltaY;
        }, { passive: false });
    }
});

async function forceDownload(e, url, fileName) {
    if (e) e.preventDefault();
    const btn = e.currentTarget;
    
    if (btn.classList.contains('downloading')) return;
    
    const originalContent = btn.innerHTML;
    
    btn.classList.add('downloading');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 下载中...';
    btn.style.opacity = '0.7';

    try {
        // data URL → 转成 Blob 再下载（避免浏览器直接处理超长 data URL 导致卡顿/黑屏）
        if (url.startsWith('data:')) {
            const res = await fetch(url);
            const blob = await res.blob();
            const blobUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
            return;
        }

        // blob: URL → 直接下载，无需 fetch
        if (url.startsWith('blob:')) {
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            return;
        }

        // 网络 URL → fetch 后下载
         const response = await fetch(url);
         if (!response.ok) throw new Error('Network response was not ok');
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
        console.error("Download failed, fallback to new tab", err);
        window.open(url, '_blank');
    } finally {
        btn.classList.remove('downloading');
        btn.innerHTML = originalContent;
        btn.style.opacity = '1';
    }
}

function setupEventListeners() {
    const promptInput = document.getElementById('prompt');
    const dropZone = document.getElementById('dropZone');
    
    // 点击折叠态的输入区域时，自动展开
    dropZone.addEventListener('click', (e) => {
        if (dropZone.classList.contains('collapsed')) {
            e.preventDefault();
            e.stopPropagation();
            toggleComposerFold(e);
        }
    });

    promptInput.addEventListener('paste', (e) => {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        let files = [];
        for (let item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                files.push(item.getAsFile());
            }
        }
        if (files.length > 0) {
            e.preventDefault();
            addFiles(files);
        }
    });

    dropZone.addEventListener('dragover', (e) => { 
        e.preventDefault(); 
        e.stopPropagation();
        dropZone.classList.add('drag-over'); 
    });
    
    dropZone.addEventListener('dragleave', (e) => { 
        e.preventDefault(); 
        e.stopPropagation();
        dropZone.classList.remove('drag-over'); 
    });
    
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
        
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        if (files.length > 0) {
            addFiles(files);
        }
    });
    
    promptInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
        if(this.value === '') this.style.height = 'auto';
    });
}

// ==================== 对话模式功能 ====================
const CHAT_MAX_IMAGES = 5;
const CHAT_MAX_CONTEXT_MESSAGES = 20;
const CHAT_MAX_IMAGES_IN_CONTEXT = 4;
const CHAT_SYSTEM_PROMPT = '你是 Loris 绘图工作平台的智能助手，可以回答用户问题、理解图片内容，并在需要时给出绘图相关建议。请用简洁清晰的中文回复。';
const DEAD_IMAGE_URLS_KEY = 'loris_dead_image_urls';
const DEAD_IMAGE_URLS_MAX = 300;

let chatConversations = [];
let currentChatId = null;
let chatModeInitialized = false;
let chatIsSending = false;
let chatAbortController = null;
const DEBUG_LOG_KEY = 'loris_debug_log';
window.LORIS_DEBUG_LOG = localStorage.getItem(DEBUG_LOG_KEY) === '1';
function setDebugLogEnabled(enabled) {
    window.LORIS_DEBUG_LOG = !!enabled;
    localStorage.setItem(DEBUG_LOG_KEY, window.LORIS_DEBUG_LOG ? '1' : '0');
    syncDebugLogToggle();
    debugInfo(`Debug log ${window.LORIS_DEBUG_LOG ? 'enabled' : 'disabled'}`);
}
function syncDebugLogToggle() {
    const toggle = document.getElementById('debugLogToggle');
    if (toggle) toggle.checked = !!window.LORIS_DEBUG_LOG;
}
function debugInfo(...args) {
    if (window.LORIS_DEBUG_LOG) console.info(...args);
}
function debugLog(...args) {
    if (window.LORIS_DEBUG_LOG) console.log(...args);
}
function debugWarn(...args) {
    if (window.LORIS_DEBUG_LOG) console.warn(...args);
}

function isTrackableRemoteImageUrl(url) {
    return /^https?:\/\//i.test(String(url || ''));
}

function getDeadImageUrls() {
    try {
        const raw = localStorage.getItem(DEAD_IMAGE_URLS_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(list) ? list : []);
    } catch (_) {
        return new Set();
    }
}

function saveDeadImageUrls(set) {
    try {
        const list = Array.from(set).slice(-DEAD_IMAGE_URLS_MAX);
        localStorage.setItem(DEAD_IMAGE_URLS_KEY, JSON.stringify(list));
    } catch (_) {}
}

function isDeadImageUrl(url) {
    return isTrackableRemoteImageUrl(url) && getDeadImageUrls().has(url);
}

function markDeadImageUrl(url) {
    if (!isTrackableRemoteImageUrl(url)) return;
    const set = getDeadImageUrls();
    if (!set.has(url)) {
        set.add(url);
        saveDeadImageUrls(set);
    }
}

function handleImageLoadError(imgEl, placeholderText = '图片链接已失效') {
    const url = imgEl?.currentSrc || imgEl?.src || imgEl?.getAttribute?.('src') || '';
    if (url && typeof url === 'string' && url.startsWith('data:image/svg+xml')) {
        return; // SVG 默认图标绝对不当作错误处理
    }
    markDeadImageUrl(url);
    if (!imgEl) return;
    imgEl.onerror = null;
    imgEl.removeAttribute('src');
    imgEl.style.display = 'none';
    const next = imgEl.nextElementSibling;
    if (next && next.classList?.contains('img-error-placeholder')) {
        next.style.display = 'flex';
        const p = next.querySelector('p');
        if (p) p.textContent = placeholderText;
        return;
    }
    const fallback = document.createElement('div');
    fallback.className = 'img-error-placeholder';
    fallback.style.cssText = 'display:flex;align-items:center;justify-content:center;min-height:80px;background:var(--bg-hover);border-radius:8px;padding:12px;text-align:center;color:var(--text-sub);font-size:13px;';
    fallback.textContent = placeholderText;
    imgEl.insertAdjacentElement('afterend', fallback);
}

function renderSafeImageOrPlaceholder(src, imageHtml, placeholderText = '图片链接已失效') {
    return isDeadImageUrl(src)
        ? `<div class="img-error-placeholder" style="display:flex;align-items:center;justify-content:center;min-height:80px;background:var(--bg-hover);border-radius:8px;padding:12px;text-align:center;color:var(--text-sub);font-size:13px;">${escapeHTML(placeholderText)}</div>`
        : imageHtml;
}

function getDeadImagePlaceholderDataUrl(width = 160, height = 120) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect fill="%23e5e7eb" width="100%" height="100%"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%236b7280" font-size="14">图片链接已失效</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function getSafeImageSrc(src, width = 160, height = 120) {
    return isDeadImageUrl(src) ? getDeadImagePlaceholderDataUrl(width, height) : (src || '');
}

function resolveChatApiConfig(modelId) {
    const model = modelId || document.getElementById('chatModelSelect')?.value || 'gemini-3.1-pro';
    const isModelScope = model.startsWith('Qwen/') || model.includes('Qwen3') || model.startsWith('moonshotai/');
    const isGPT55 = model === 'gpt-5.5';

    if (isModelScope) {
        return {
            apiBase: 'https://api-inference.modelscope.cn',
            modelId: model,
            token: document.getElementById('modelscopeToken')?.value?.trim(),
            tokenLabel: 'ModelScope Token',
            isModelScope: true
        };
    }
    if (isGPT55) {
        return {
            apiBase: 'https://grsaiapi.com',
            modelId: model,
            token: document.getElementById('token')?.value?.trim(),
            tokenLabel: 'API Token',
            isModelScope: false
        };
    }
    return {
        apiBase: document.getElementById('chatApiBase')?.value?.trim() || getDefaultChatApiBase(),
        modelId: model,
        token: document.getElementById('token')?.value?.trim(),
        tokenLabel: 'API Token',
        isModelScope: false
    };
}

// API 上下文图片压缩（不影响原图和图生图，仅压缩发送给对话模型的上下文图片）
const _apiImageCache = new Map();
async function compressImageForApi(base64Url, maxSize = 1024) {
    if (_apiImageCache.has(base64Url)) {
        const cached = _apiImageCache.get(base64Url);
        _apiImageCache.delete(base64Url);
        _apiImageCache.set(base64Url, cached);
        return cached;
    }
    const result = await new Promise((resolve) => {
        const img = new Image();
        img.onload = function() {
            if (img.width <= maxSize && img.height <= maxSize) { resolve(base64Url); return; }
            const scale = Math.min(maxSize / img.width, maxSize / img.height);
            const w = Math.round(img.width * scale);
            const h = Math.round(img.height * scale);
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = function() { resolve(base64Url); };
        img.src = base64Url;
    });
    _apiImageCache.set(base64Url, result);
    // LRU淘汰：超过50条时删除最老的缓存
    if (_apiImageCache.size > 50) {
        _apiImageCache.delete(_apiImageCache.keys().next().value);
    }
    return result;
}

async function buildMessageContentForApi(msg, includeImages) {
    const parts = [];
    if (includeImages && msg.images?.length) {
        for (const img of msg.images) {
            let url = img.data || img.url;
            if (url) {
                if (url.startsWith('data:')) url = await compressImageForApi(url, 1024);
                parts.push({ type: 'image_url', image_url: { url } });
            }
        }
    }
    const text = (msg.content || '').trim();
    if (text) {
        parts.push({ type: 'text', text });
    } else if (parts.length > 0) {
        parts.push({ type: 'text', text: '请结合图片回答。' });
    }
    if (parts.length === 0) return '';
    if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
    return parts;
}

// 通用 API 上下文消息构建（滑动窗口保留最近图片 + 上下文图片压缩到1024px）
async function buildApiContextMessages(systemPrompt, chat, excludeLast = false) {
    const apiMessages = [{ role: 'system', content: systemPrompt }];
    const history = chat.messages.filter(m => !m.pending && !m.error);
    const filtered = excludeLast ? history.slice(0, -1) : history;
    const sliced = filtered.slice(-CHAT_MAX_CONTEXT_MESSAGES);

    // 滑动窗口：从最新消息向前分配图片槽位（保留最近的图片而非最早的）
    const imageMsgSet = new Set();
    let remainingSlots = CHAT_MAX_IMAGES_IN_CONTEXT;
    const userMsgsWithImages = sliced.filter(m => m.role !== 'ai' && m.images?.length);
    for (let i = userMsgsWithImages.length - 1; i >= 0 && remainingSlots > 0; i--) {
        imageMsgSet.add(userMsgsWithImages[i]);
        remainingSlots -= Math.min(userMsgsWithImages[i].images.length, remainingSlots);
    }

    for (const msg of sliced) {
        const role = msg.role === 'ai' ? 'assistant' : 'user';
        const includeImages = imageMsgSet.has(msg);
        const content = await buildMessageContentForApi(msg, includeImages);
        if (content === '' || (Array.isArray(content) && content.length === 0)) continue;
        apiMessages.push({ role, content });
    }
    return apiMessages;
}

async function buildChatApiMessages(chat, config) {
    return buildApiContextMessages(CHAT_SYSTEM_PROMPT, chat);
}

// ========== 对话模式图片缓存（IndexedDB） ==========
function generateChatImageThumbnail(imageUrl, maxWidth = 200) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ratio = maxWidth / img.naturalWidth;
            canvas.width = maxWidth;
            canvas.height = Math.round(img.naturalHeight * ratio);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.6));
        };
        img.onerror = () => resolve(null);
        img.src = imageUrl;
    });
}

function fetchImageAsBase64(imageUrl) {
    return new Promise(async (resolve) => {
        try {
            const resp = await fetch(imageUrl);
            if (!resp.ok) return resolve(null);
            const blob = await resp.blob();
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
        } catch (_) { resolve(null); }
    });
}

// --- 图片缓存大小管理和用户上传缓存 ---

function getChatImageCacheKind(entryOrKey) {
    const key = typeof entryOrKey === 'string' ? entryOrKey : (entryOrKey?.url || '');
    return (typeof entryOrKey === 'object' && entryOrKey?.kind) || (key && key.startsWith('user-img-') ? 'user' : 'ai');
}

// 计算缓存总大小（通过内存索引，无需getAll）
async function getCacheTotalSize(cacheDb) {
    await _initCacheIndex(cacheDb);
    return _cacheIndexTotalSize();
}

// 缓存安全线淘汰：超过500MB时淘汰最老的原图，原图全清还超才整条淘汰
async function evictCacheBySize(cacheDb, newEntrySize) {
    await _initCacheIndex(cacheDb);
    let total = _cacheIndexTotalSize() + newEntrySize;

    // 460MB警告 — 弹窗提示（防抖10秒）
    if (total >= CACHE_SIZE_WARN && total < CACHE_SIZE_MAX) {
        console.warn(`图片缓存接近上限: ${(total / 1024 / 1024).toFixed(0)}MB / ${CACHE_SIZE_MAX / 1024 / 1024}MB`);
        const now = Date.now();
        if (now - _lastCacheWarnToast > 10000 && typeof showToast === 'function') {
            _lastCacheWarnToast = now;
            showToast(`⚠️ 图片缓存接近上限 (${(total / 1024 / 1024).toFixed(0)}MB/500MB)，即将清理旧图原图`);
        }
    }

    if (total < CACHE_SIZE_MAX) return; // 未超限

    // 超过500MB，从最老的开始淘汰 — 弹窗提示
    if (typeof showToast === 'function') showToast(`⚠️ 图片缓存超限 (${(total / 1024 / 1024).toFixed(0)}MB/500MB)，正在清理旧图原图…`);
    // 从内存索引排序，不再 getAll
    const sorted = [..._cacheIndex.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    const writeTx = cacheDb.transaction([CHAT_IMAGE_CACHE_STORE], 'readwrite');
    const store = writeTx.objectStore(CHAT_IMAGE_CACHE_STORE);

    for (const [url, info] of sorted) {
        if (total < CACHE_SIZE_MAX) break;
        if (info.hasOrig && info.origLen > 0) {
            // 先清原图
            store.put({ url, original: null, evicted: true, thumbnail: null, timestamp: info.ts });
            total -= info.origLen;
            _cacheIndexUpdate(url, { origLen: 0, hasOrig: false });
        } else {
            // 原图已清还超，整条淘汰
            total -= info.thumbLen;
            store.delete(url);
            _cacheIndexDelete(url);
        }
    }
}

// 用户上传图片：生成缩略图（canvas压缩）
function generateThumbnailFromBase64(base64, maxSize = 400, quality = 0.6) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            if (width > maxSize || height > maxSize) {
                const ratio = Math.min(maxSize / width, maxSize / height);
                width = Math.round(width * ratio);
                height = Math.round(height * ratio);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => resolve(null);
        img.src = base64;
    });
}

// 用户上传图片：压缩原图到目标大小以内
function compressOriginalToLimit(base64, maxBytes = 5 * 1024 * 1024) {
    return new Promise((resolve) => {
        // base64长度 × 3/4 ≈ 原始字节
        if (base64.length * 0.75 <= maxBytes) return resolve(base64);
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            let quality = 0.7;
            let result = canvas.toDataURL('image/jpeg', quality);
            while (result.length * 0.75 > maxBytes && quality > 0.1) {
                quality -= 0.1;
                result = canvas.toDataURL('image/jpeg', quality);
            }
            // 如果降低质量还不够，缩小分辨率
            if (result.length * 0.75 > maxBytes) {
                const scale = Math.sqrt(maxBytes / (result.length * 0.75)) * 0.9;
                const w = Math.round(img.naturalWidth * scale);
                const h = Math.round(img.naturalHeight * scale);
                const c2 = document.createElement('canvas');
                c2.width = w; c2.height = h;
                c2.getContext('2d').drawImage(img, 0, 0, w, h);
                result = c2.toDataURL('image/jpeg', 0.7);
            }
            resolve(result);
        };
        img.onerror = () => resolve(base64);
        img.src = base64;
    });
}

// 缓存用户上传图片（缩略图必存 + 压缩原图尽量存）
async function cacheUserUploadImage(cacheKey, thumbnailBase64, originalBase64) {
    let cacheDb;
    try { cacheDb = await initImageCacheDB(); } catch (_) { return; }
    if (!cacheDb) return;
    try {
        await _initCacheIndex(cacheDb);
        const compressedOriginal = originalBase64 ? await compressOriginalToLimit(originalBase64) : null;
        const entrySize = (thumbnailBase64 || '').length + (compressedOriginal || '').length;
        await evictCacheBySize(cacheDb, entrySize);

        // 淘汰用户上传原图总量超100MB的部分（使用内存索引）
        if (compressedOriginal) {
            let userOrigTotal = compressedOriginal.length;
            const userEntries = [];
            for (const [url, info] of _cacheIndex.entries()) {
                if (info.kind === 'user') {
                    userOrigTotal += info.origLen;
                    if (info.hasOrig) userEntries.push([url, info]);
                }
            }
            if (userOrigTotal > USER_ORIGINAL_MAX) {
                userEntries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
                const writeTx2 = cacheDb.transaction([CHAT_IMAGE_CACHE_STORE], 'readwrite');
                const store2 = writeTx2.objectStore(CHAT_IMAGE_CACHE_STORE);
                for (const [url, info] of userEntries) {
                    if (userOrigTotal <= USER_ORIGINAL_MAX) break;
                    userOrigTotal -= info.origLen;
                    // 淘汰原图但保留缩略图（先读取旧条目以保留thumbnail）
                    const evictReq = store2.get(url);
                    evictReq.onsuccess = () => {
                        const old = evictReq.result || {};
                        store2.put({ url, original: null, thumbnail: old.thumbnail || null, evicted: true, timestamp: info.ts, kind: 'user' });
                    };
                    _cacheIndexUpdate(url, { origLen: 0, hasOrig: false });
                }
            }
        }

        const writeTx = cacheDb.transaction([CHAT_IMAGE_CACHE_STORE], 'readwrite');
        writeTx.objectStore(CHAT_IMAGE_CACHE_STORE).put({
            url: cacheKey,
            kind: 'user',
            thumbnail: thumbnailBase64 || null,
            original: compressedOriginal || null,
            timestamp: Date.now()
        });
        _cacheIndexSet(cacheKey, thumbnailBase64, compressedOriginal, 'user');
    } catch (e) {
        debugWarn('缓存用户上传图片失败:', e);
    }
}

async function cacheChatImageToDB(imageUrl) {
    if (!imageUrl) return;
    let cacheDb;
    try {
        cacheDb = await initImageCacheDB();
    } catch (_) { return; }
    if (!cacheDb) return;
    try {
        await _initCacheIndex(cacheDb);
        // 检查是否已缓存（优先用内存索引快速判断）
        if (_cacheIndex.has(imageUrl)) return;

        // 并行生成缩略图和下载原图
        const [thumbnail, original] = await Promise.all([
            generateChatImageThumbnail(imageUrl, 200),
            fetchImageAsBase64(imageUrl)
        ]);

        if (!thumbnail && !original) return;

        const entrySize = (thumbnail || '').length + (original || '').length;
        await evictCacheBySize(cacheDb, entrySize);

        // LRU淘汰：AI回传图只限制AI原图数量（使用内存索引）
        const aiOriginalRecords = [];
        for (const [url, info] of _cacheIndex.entries()) {
            if (info.kind === 'ai' && info.hasOrig) {
                aiOriginalRecords.push([url, info]);
            }
        }
        aiOriginalRecords.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
        while (aiOriginalRecords.length >= CHAT_IMAGE_CACHE_MAX) {
            const [url, info] = aiOriginalRecords.shift();
            // 淘汰：删除原图数据，保留缩略图（先读取旧条目以保留thumbnail）
            const evictTx = cacheDb.transaction([CHAT_IMAGE_CACHE_STORE], 'readwrite');
            const evictStore = evictTx.objectStore(CHAT_IMAGE_CACHE_STORE);
            const evictReq = evictStore.get(url);
            evictReq.onsuccess = () => {
                const old = evictReq.result || {};
                evictStore.put({
                    url: url,
                    original: null,
                    thumbnail: old.thumbnail || null,
                    evicted: true,
                    timestamp: info.ts,
                    kind: 'ai'
                });
            };
            _cacheIndexUpdate(url, { origLen: 0, hasOrig: false });
        }

        // 写入新缓存
        const writeTx = cacheDb.transaction([CHAT_IMAGE_CACHE_STORE], 'readwrite');
        writeTx.objectStore(CHAT_IMAGE_CACHE_STORE).put({
            url: imageUrl,
            kind: 'ai',
            thumbnail: thumbnail || null,
            original: original || null,
            timestamp: Date.now()
        });
        _cacheIndexSet(imageUrl, thumbnail, original, 'ai');
    } catch (_) {}
}

async function getCachedChatImageFromDB(imageUrl) {
    if (!imageUrl) return null;
    let cacheDb;
    try {
        cacheDb = await initImageCacheDB();
    } catch (_) { return null; }
    if (!cacheDb) return null;
    try {
        return await new Promise((resolve) => {
            const tx = cacheDb.transaction([CHAT_IMAGE_CACHE_STORE], 'readonly');
            const req = tx.objectStore(CHAT_IMAGE_CACHE_STORE).get(imageUrl);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch (_) { return null; }
}

// 500ms防抖：短时间内多次调用只执行一次，避免频繁写localStorage/IndexedDB
let _flushChatTimer = null;
function flushChatPersistence() {
    if (_flushChatTimer) clearTimeout(_flushChatTimer);
    _flushChatTimer = setTimeout(() => {
        _flushChatTimer = null;
        saveChatsToDB();
    }, 500);
    return Promise.resolve();
}
// 同步立即保存（用于 pagehide / visibilitychange 等页面即将卸载的场景）
// 只做 localStorage 同步写入，不碰 IndexedDB（异步操作在页面卸载时可能来不及完成）
function flushChatPersistenceSync() {
    if (_flushChatTimer) {
        clearTimeout(_flushChatTimer);
        _flushChatTimer = null;
    }
    const payload = buildChatPersistencePayload();
    saveChatsToLocalStorage(payload);
}

function cloneChatImageForStorage(img) {
    if (!img) return null;
    const data = img.previewData || img.data || img.url || '';
    // 不再因 data 为空就返回 null — 保留图片对象结构，数据可能在 IndexedDB 中
    return {
        data: data || '',
        previewData: data || '',
        name: img.name || img.originalName || '',
        originalName: img.originalName || img.name || '',
        type: img.type || 'image/jpeg',
        taskId: img.taskId || '',
        source: img.source || 'chat',
        prompt: img.prompt || '',
        label: img.label || '',
        aspectRatio: img.aspectRatio || '1:1',
        cacheKey: img.cacheKey || ''
    };
}

function buildChatPersistencePayload() {
    return {
        key: CHAT_DB_KEY,
        conversations: chatConversations.map(c => ({
            ...c,
            messages: (c.messages || []).filter(m => !m.pending).map(m => ({
                ...m,
                images: Array.isArray(m.images) ? m.images.map(cloneChatImageForStorage).filter(Boolean) : [],
                imageTask: m.imageTask ? {
                    ...m.imageTask,
                    images: Array.isArray(m.imageTask.images) ? m.imageTask.images.map(cloneChatImageForStorage).filter(Boolean) : []
                } : undefined
            }))
        })),
        currentChatId,
        updatedAt: Date.now()
    };
}

function buildLeanChatLocalStoragePayload(payload) {
    const isBase64 = (v) => v && typeof v === 'string' && v.startsWith('data:');
    return {
        conversations: (payload.conversations || []).map(conv => ({
            ...conv,
            messages: (conv.messages || []).map(msg => {
                const clean = { ...msg };
                if (Array.isArray(clean.images)) {
                    clean.images = clean.images.map(img => ({
                        ...img,
                        data: isBase64(img.data) ? '' : (img.data || ''),
                        previewData: isBase64(img.previewData) ? '[stripped-url]' : (img.previewData || ''),
                        url: img.url || ''
                    }));
                }
                if (clean.imageTask?.images) {
                    clean.imageTask = {
                        ...clean.imageTask,
                        images: clean.imageTask.images.map(img => ({
                            ...img,
                            data: isBase64(img.data) ? '' : (img.data || ''),
                            url: img.url || '',
                            previewData: isBase64(img.previewData) ? '[stripped-url]' : (img.previewData || '')
                        }))
                    };
                }
                return clean;
            })
        })),
        currentChatId: payload.currentChatId,
        updatedAt: payload.updatedAt
    };
}

function saveChatsToLocalStorage(payload) {
    try {
        const lean = buildLeanChatLocalStoragePayload(payload);
        localStorage.setItem(CHAT_LOCALSTORAGE_KEY, JSON.stringify(lean));
    } catch (e) {
        // 超限时用更激进的降级策略重试
        if (e.name === 'QuotaExceededError' || /quota/i.test(e.message || '')) {
            debugWarn('对话 localStorage 超限，尝试激进压缩重试...');
            try {
                // 激进策略：只保留最近 10 条对话，完全剥离图片对象
                const maxConvs = 10;
                const sorted = [...(payload.conversations || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                const minimal = {
                    conversations: sorted.slice(0, maxConvs).map(conv => ({
                        id: conv.id,
                        title: conv.title || '',
                        createdAt: conv.createdAt,
                        updatedAt: conv.updatedAt,
                        model: conv.model,
                        messages: (conv.messages || []).map(msg => ({
                            role: msg.role,
                            content: msg.content || '',
                            timestamp: msg.timestamp,
                            error: msg.error || false,
                            // 完全去掉 images 和 imageTask，由 IndexedDB 兜底
                        }))
                    })),
                    currentChatId: payload.currentChatId,
                    updatedAt: payload.updatedAt
                };
                localStorage.setItem(CHAT_LOCALSTORAGE_KEY, JSON.stringify(minimal));
                debugWarn(`激进压缩成功，仅保留 ${minimal.conversations.length} 条对话文本`);
            } catch (e2) {
                debugWarn('激进压缩后仍无法保存:', e2.message || e2);
            }
        } else {
            debugWarn('对话 localStorage 备份失败:', e.message || e);
        }
    }
}

function loadChatsFromLocalStorage() {
    try {
        const raw = localStorage.getItem(CHAT_LOCALSTORAGE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (data?.conversations?.length) {
            chatConversations = data.conversations;
            chatConversations.forEach(chat => {
                (chat.messages || []).forEach(msg => {
                    if (Array.isArray(msg.images)) {
                        msg.images = msg.images.map(img => {
                            // '[stripped]' / '[stripped-url]' 是 localStorage 超限时的占位符，不是有效图片数据
                            const clean = (v) => (v && typeof v === 'string' && !v.startsWith('[stripped')) ? v : '';
                            const d = clean(img.data) || clean(img.url) || '';
                            const p = clean(img.previewData) || d;
                            return { ...img, previewData: p, data: d };
                        });
                        // 不再 filter 移除空 data 图片 — 保留结构让 IndexedDB 有机会覆盖恢复
                    }
                    if (msg.imageTask?.images) {
                        msg.imageTask.images = msg.imageTask.images.map(img => {
                            const clean = (v) => (v && typeof v === 'string' && !v.startsWith('[stripped')) ? v : '';
                            return {
                                ...img,
                                previewData: clean(img.previewData) || clean(img.data) || clean(img.url) || '',
                                data: clean(img.data) || clean(img.previewData) || clean(img.url) || ''
                            };
                        });
                        // 同样不 filter
                    }
                });
            });
            const exists = chatConversations.some(c => c.id === data.currentChatId);
            currentChatId = exists ? data.currentChatId : chatConversations[0].id;
            return true;
        }
    } catch (e) {
        debugWarn('读取对话 localStorage 失败:', e);
    }
    return false;
}

async function saveChatsToDB() {
    const payload = buildChatPersistencePayload();
    // localStorage 作为主存储（360浏览器 file:// 协议下更可靠）
    saveChatsToLocalStorage(payload);
    // IndexedDB 作为辅助备份（等待事务完成）
    await saveChatsToIndexedDB(payload);
}

function saveChatsToIndexedDB(payload) {
    const doPut = (database) => {
        if (!database || !database.objectStoreNames.contains(CHAT_STORE_NAME)) return Promise.resolve();
        return new Promise((resolve) => {
            try {
                const tx = database.transaction([CHAT_STORE_NAME], 'readwrite');
                const req = tx.objectStore(CHAT_STORE_NAME).put(payload);
                req.onerror = () => { debugWarn('IndexedDB 对话写入失败:', req.error); resolve(); };
                tx.oncomplete = () => resolve();
                tx.onerror = () => { debugWarn('IndexedDB 对话事务失败:', tx.error); resolve(); };
                tx.onabort = () => resolve();
            } catch (e) {
                debugWarn('IndexedDB 对话事务异常:', e);
                resolve();
            }
        });
    };
    if (db) {
        return doPut(db);
    } else {
        return initDB().then(doPut).catch(() => {});
    }
}

// 从图片缓存恢复被 strip 的图片数据（localStorage 加载后 base64 丢失的保底修复）
async function healStrippedChatImages() {
    let cacheDb;
    try { cacheDb = await initImageCacheDB(); } catch (_) { return; }
    if (!cacheDb) return;

    let healed = 0;
    for (const conv of chatConversations) {
        for (const msg of (conv.messages || [])) {
            const allImages = [
                ...(Array.isArray(msg.images) ? msg.images : []),
                ...(msg.imageTask?.images || [])
            ];
            for (const img of allImages) {
                // 只修复有 cacheKey 但 data 为空的图片
                const hasData = img.data && typeof img.data === 'string' && img.data.length > 100 && !img.data.startsWith('[stripped');
                if (hasData || !img.cacheKey) continue;
                try {
                    const cached = await getCachedChatImageFromDB(img.cacheKey);
                    if (cached) {
                        const restored = cached.original || cached.thumbnail || '';
                        if (restored) {
                            img.data = restored;
                            img.previewData = restored;
                            healed++;
                        }
                    }
                } catch (_) {}
            }
        }
    }
    if (healed > 0) {
        debugLog(`从图片缓存恢复了 ${healed} 张图片`);
        // 恢复后立即保存到 IndexedDB，防止下次加载再次丢失
        void saveChatsToIndexedDB(buildChatPersistencePayload());
    }
}

async function loadChatsFromDB() {
    // 1. 先从 localStorage 恢复
    const localLoaded = loadChatsFromLocalStorage();
    const localUpdatedAt = localLoaded ? (JSON.parse(localStorage.getItem(CHAT_LOCALSTORAGE_KEY) || '{}').updatedAt || 0) : 0;

    // 2. 尝试 IndexedDB
    try {
        await Promise.race([
            initDB(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 2000))
        ]);
    } catch (_) {}

    let dbData = null;
    if (db && db.objectStoreNames.contains(CHAT_STORE_NAME)) {
        dbData = await new Promise((resolve) => {
            try {
                const tx = db.transaction([CHAT_STORE_NAME], 'readonly');
                const req = tx.objectStore(CHAT_STORE_NAME).get(CHAT_DB_KEY);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
            } catch (_) {
                resolve(null);
            }
        });
    }

    const dbUpdatedAt = dbData?.updatedAt || 0;

    // 3. 比较 updatedAt，取最新数据源（>= 时优先 IndexedDB，因为 localStorage 可能被 strip 过）
    if (dbData?.conversations?.length && dbUpdatedAt >= localUpdatedAt) {
        // IndexedDB 更新，用 IndexedDB 数据
        chatConversations = dbData.conversations;
        const exists = chatConversations.some(c => c.id === dbData.currentChatId);
        currentChatId = exists ? dbData.currentChatId : chatConversations[0].id;
        saveChatsToLocalStorage(dbData); // 同步到 localStorage
        return true;
    }

    // localStorage 数据更新或一样新，或 IndexedDB 没数据
    if (localLoaded && chatConversations.length > 0) {
        // localStorage 的 base64 图片被 strip 了，尝试从图片缓存恢复
        await healStrippedChatImages();
        return true;
    }

    // localStorage 没数据，IndexedDB 有数据但时间戳没比较出来
    if (dbData?.conversations?.length) {
        chatConversations = dbData.conversations;
        const exists = chatConversations.some(c => c.id === dbData.currentChatId);
        currentChatId = exists ? dbData.currentChatId : chatConversations[0].id;
        saveChatsToLocalStorage(dbData);
        return true;
    }

    return false;
}

function syncChatModelSelect() {
    const chat = chatConversations.find(c => c.id === currentChatId);
    const sel = document.getElementById('chatModelSelect');
    if (!chat?.model || !sel) return;
    sel.value = chat.model;
    const modelValueEl = document.getElementById('chatModelValue');
    if (modelValueEl) modelValueEl.textContent = chat.model;
    const items = Array.from(document.querySelectorAll('#chatModelMenu .custom-select-item'));
    items.forEach(item => {
        item.classList.toggle('selected', item.textContent.trim() === chat.model);
    });
    const modelWrap = document.querySelector('.chat-model-select.chat-quick-select[data-kind="chat-model"] .custom-select-wrapper');
    if (modelWrap) {
        const longest = items.reduce((max, item) => Math.max(max, item.textContent.trim().length), 0);
        const width = Math.max(300, Math.min(460, 54 + longest * 10.2));
        modelWrap.style.width = `${width}px`;
        modelWrap.style.minWidth = `${width}px`;
        modelWrap.style.maxWidth = `${width}px`;
    }
}

function setChatSendingState(sending) {
    chatIsSending = sending;
    const sendBtn = document.getElementById('chatSendBtn');
    const input = document.getElementById('chatInput');
    if (sendBtn) {
        sendBtn.innerHTML = sending ? '<i class="fas fa-stop"></i>' : '<i class="fas fa-paper-plane"></i>';
        sendBtn.title = sending ? '停止生成' : '发送';
    }
    if (input) input.disabled = sending;
}

function stopChatGeneration() {
    if (chatAbortController) chatAbortController.abort();
}

async function requestChatCompletion(chat) {
    const modelSelect = document.getElementById('chatModelSelect');
    const modelId = modelSelect?.value;
    if (modelId) chat.model = modelId;

    const config = resolveChatApiConfig(modelId);
    if (!config.token) {
        showToast(`请先填写 ${config.tokenLabel}`);
        throw new Error(`缺少 ${config.tokenLabel}`);
    }

    const existingPending = chat.messages[chat.messages.length - 1];
    if (existingPending?.pending && existingPending.role === 'ai') {
        existingPending.content = '';
        existingPending.streaming = true;
    } else {
        chat.messages.push({ role: 'ai', content: '', pending: true, streaming: true, timestamp: Date.now() });
    }
    renderChatMessages();

    chatAbortController = new AbortController();
    setChatSendingState(true);

    // SSE超时状态（需在try/catch/finally共享）
    let sseTimeoutId = null;
    let isSseTimeout = false;

    try {
        const apiMessages = await buildChatApiMessages(chat, config);
        const url = `${config.apiBase.replace(/\/$/, '')}/v1/chat/completions`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.token}`
            },
            body: JSON.stringify({
                model: config.modelId,
                stream: true,
                messages: apiMessages
            }),
            signal: chatAbortController.signal
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || errorData.message || `HTTP ${response.status}`);
        }

        // 流式读取
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        const pending = chat.messages[chat.messages.length - 1];

        // 节流渲染：每 60ms 最多渲染一次（使用轻量级流式更新，不重建DOM）
        let lastRenderTime = 0;
        const throttledRender = () => {
            const now = Date.now();
            if (now - lastRenderTime >= 60) {
                lastRenderTime = now;
                updateStreamingBubble(fullText);
            }
        };

        // 60秒无数据超时：每次收到数据重置计时器
        const SSE_TIMEOUT_MS = 60000;
        const resetTimeout = () => {
            if (sseTimeoutId) clearTimeout(sseTimeoutId);
            sseTimeoutId = setTimeout(() => {
                isSseTimeout = true;
                try { reader.cancel(); } catch (_) {}
            }, SSE_TIMEOUT_MS);
        };
        resetTimeout(); // 启动首次计时

        while (true) {
            const { done, value } = await reader.read();
            resetTimeout();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 保留不完整的行

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const dataStr = trimmed.slice(5).trim();
                if (dataStr === '[DONE]') continue;

                try {
                    const chunk = JSON.parse(dataStr);
                    // OpenAI 格式
                    const delta = chunk.choices?.[0]?.delta;
                    if (delta?.content) {
                        fullText += delta.content;
                        if (pending) pending.content = fullText;
                        throttledRender();
                    }
                } catch (e) {
                    // 忽略解析错误
                }
            }
        }

        if (isSseTimeout) throw new Error('SSE_TIMEOUT');
        if (!fullText) throw new Error('未收到有效回复');

        // 最终渲染一次确保完整
        if (pending) {
            pending.content = fullText;
            pending.streaming = false;
            pending.pending = false;
        }
    } catch (err) {
        const pending = chat.messages[chat.messages.length - 1];
        if (pending?.pending) chat.messages.pop();

        if (err.name === 'AbortError') {
            // 用户主动中止：保留已收到的内容
            if (pending?.content) {
                pending.streaming = false;
                pending.pending = false;
                chat.messages.push(pending);
            } else {
                showToast('已停止生成');
            }
        } else if (isSseTimeout) {
            // 60秒无数据超时
            const timeoutMsg = '响应超时（60秒无数据），请重试';
            if (pending?.content) {
                pending.streaming = false;
                pending.pending = false;
                pending.content += '\n\n⚠️ ' + timeoutMsg;
                chat.messages.push(pending);
            } else {
                chat.messages.push({
                    role: 'ai',
                    content: `请求失败：${timeoutMsg}`,
                    error: true,
                    timestamp: Date.now()
                });
            }
            showToast(timeoutMsg);
        } else {
            const errMsg = err.message || '请求失败';
            chat.messages.push({
                role: 'ai',
                content: `请求失败：${errMsg}`,
                error: true,
                timestamp: Date.now()
            });
            showToast(errMsg);
        }
    } finally {
        if (sseTimeoutId) { clearTimeout(sseTimeoutId); sseTimeoutId = null; }
        chatAbortController = null;
        setChatSendingState(false);
        void flushChatPersistence();
        renderChatMessages();
    }
}

function getChatImageModelId() {
    return document.getElementById('chatImageModelSelect')?.value || 'GPT Image-2';
}

function isChatFirstImageQuery(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    const explicitExecute = /(帮我|给我|请|直接|现在|开始|马上)?\s*(生成|画|绘制|创建|做|出|渲染)\s*(一张|一幅|一个|个|张|幅)?/.test(raw)
        && !/(吗|么|嘛|能不能|可不可以|可以吗|会不会|行不行|好不好|难不难)/.test(raw);
    if (explicitExecute) return false;
    const abilityQuestion = /(你|这个|这里|当前)?.{0,6}(能|可以|会|支持).{0,8}(生成图|生成图片|生图|画图|画画|出图|图生图|文生图).{0,8}(吗|么|嘛|不|功能|怎么用|介绍|说明|说一下)/.test(raw);
    const explainRequest = /(功能|能力|用法|怎么用|如何用|介绍|说明|解释|说一下|讲一下|先说|先把).{0,12}(生图|生成图|生成图片|画图|图生图|文生图|功能|能力)/.test(raw)
        || /(生图|生成图|生成图片|画图|图生图|文生图).{0,12}(功能|能力|用法|怎么用|介绍|说明|解释|说一下|讲一下)/.test(raw);
    const learningQuestion = /(你觉得|请问|想问|咨询|建议|怎么学|如何学|我想学|没基础|零基础|新手|入门|好学|好画|难吗|难不难|适合学|适合新手)/.test(raw)
        && /(画|绘画|插画|抽象画|水彩|素描|油画|设计|风格|艺术)/.test(raw);
    const questionTone = /[?？]$/.test(raw) || /(吗|么|嘛|呢|如何|怎么|为什么|什么|能不能|可不可以|会不会|行不行)/.test(raw);
    const hasConsultVerb = /(你觉得|建议|介绍|说明|解释|说一下|讲一下|怎么学|如何学|想学|没基础|零基础|功能|能力|怎么用)/.test(raw);
    return abilityQuestion || explainRequest || learningQuestion || (questionTone && hasConsultVerb);
}

function detectChatImageIntent(raw, images) {
    const text = String(raw || '').trim();
    const hasImages = Array.isArray(images) && images.length > 0;
    const lower = text.toLowerCase();

    // ========== 第1层：否定词检测（最高优先级） ==========
    // "纯文生图" / "不分析" / "忽略参考图" / "不用参考图" → 强制文生图，忽略参考图
    const forceTextToImageKeywords = ['纯文生图', '不分析', '忽略参考图', '不用参考图', '不要参考图', '不参考', '不看图'];
    if (forceTextToImageKeywords.some(k => text.includes(k))) {
        return {
            mode: 'text_to_image',
            purpose: 'generate',
            prompt: text,
            hasImages: false,       // 强制忽略参考图
            needsAnalysis: false,
            forceTextToImage: true,
            forceImageToImage: false,
            source: 'user_override' // 标记为用户主动指定
        };
    }

    // ========== 第2层：无参考图 + "分析" → 提示上传图片 ==========
    const analyzeKeywords = ['分析', '类似风格', '同风格', '相似风格', '类似图片', '类似的感觉', '这种风格', '这种感觉'];
    if (!hasImages && analyzeKeywords.some(k => text.includes(k))) {
        return {
            mode: 'hint_upload',
            purpose: 'hint',
            prompt: '请先上传要分析的图片',
            hasImages: false,
            needsAnalysis: true,
            forceTextToImage: false,
            forceImageToImage: false,
            source: 'user_override'
        };
    }

    // ========== 第3层：用户主动指定模式（关键词检测） ==========
    // "文生图" → 文生图（忽略参考图）
    const userTextToImageKeywords = ['文生图', '文字生成图片', '文字生图', '文字生成', '文字出图'];
    if (userTextToImageKeywords.some(k => text.includes(k)) && !text.includes('分析') && !text.includes('图生图')) {
        return {
            mode: 'text_to_image',
            purpose: 'generate',
            prompt: text,
            hasImages: false,       // 用户明确要文生图，忽略参考图
            needsAnalysis: false,
            forceTextToImage: true,
            forceImageToImage: false,
            source: 'user_override'
        };
    }

    // "图生图" / "改图" / "修图" → 图生图
    const userImg2ImgKeywords = ['图生图', '改图', '修图'];
    if (userImg2ImgKeywords.some(k => text.includes(k))) {
        if (!hasImages) {
            return {
                mode: 'hint_upload',
                purpose: 'hint',
                prompt: '请先上传要修改的图片',
                hasImages: false,
                needsAnalysis: false,
                forceTextToImage: false,
                forceImageToImage: true,
                source: 'user_override'
            };
        }
        return {
            mode: 'image_to_image',
            purpose: 'edit',
            prompt: text,
            hasImages: true,
            needsAnalysis: false,
            forceTextToImage: false,
            forceImageToImage: true,
            source: 'user_override'
        };
    }

    // "分析" → 分析后文生图
    if (hasImages && analyzeKeywords.some(k => text.includes(k))) {
        return {
            mode: 'analyze_to_text2img',
            purpose: 'generate',
            prompt: text,
            hasImages: true,
            needsAnalysis: true,
            forceTextToImage: false,
            forceImageToImage: false,
            source: 'user_override'
        };
    }

    if (isChatFirstImageQuery(text)) return null;

    // ========== 第4层：无明确关键词 → 走原有AI判断逻辑（兜底） ==========
    const analyzeThenGenerateKeywords = [
        '分析这张图', '分析这个图', '分析图片', '提炼这张图', '参考这张图风格', '根据这张图的风格', '类似风格', '同风格', '相似风格', '设计一个类似', '生成一张类似', '画一张类似', '做一张类似', '再来一张类似', '类似的图', '类似图片', '按这个感觉', '按这种感觉', '设计不同', '不同姿势', '不同动作', '不同场景', '不同角度', '设计三张', '生成三张', '设计几张', '生成几张', '给这张图', '这张图', '参考这张图', '基于这张图', '按这张图'
    ];
    const img2ImgKeywords = [
        '改图', '修图', '抠图', '换背景', '换头发', '换发型', '换衣服', '换颜色', '替换', '修改', '调整', '改成', '变成', '保留原图', '保持人物', '保持主体', '只改', '不要改', '局部', '修复', '去掉', '移除'
    ];

    // 严格匹配：只有包含明确生图动词才触发
    const generationSignals = [
        '生成', '画', '绘制', '创建一张', '出一张', '来一张', '来一幅', '来个图', '生成个', '做个图', '画个图', '做一张', '画一张', '给我一张', '帮我生成', '帮我画', '帮我做', '做一幅', '生成一幅', '创建一张', '生成图片', '生图', '出图', '插画', '海报', '封面', '渲染', '做一张图', '画一张图', '来个', '帮我做个', '帮我出', '帮我创建'
    ];
    const hasGenerationIntent = generationSignals.some(k => text.includes(k) || lower.includes(k.toLowerCase()));

    const needsAnalysis = hasImages && analyzeThenGenerateKeywords.some(k => text.includes(k) || lower.includes(k.toLowerCase()));
    const isImageEdit = hasImages && img2ImgKeywords.some(k => text.includes(k) || lower.includes(k.toLowerCase())) && !needsAnalysis;
    // 只有明确命中生图关键词才走文生图，不再用 looksLikePrompt 宽松匹配
    const isTextToImage = hasGenerationIntent;

    if (!needsAnalysis && !isImageEdit && !isTextToImage) return null;

    return {
        mode: needsAnalysis ? 'analyze_to_text2img' : (isImageEdit ? 'image_to_image' : 'text_to_image'),
        purpose: isImageEdit ? 'edit' : 'generate',
        prompt: text || (hasImages ? '根据参考图生成图片' : '根据描述生成图片'),
        hasImages,
        needsAnalysis,
        forceTextToImage: needsAnalysis || (!isImageEdit && isTextToImage),
        forceImageToImage: isImageEdit
    };
}

function normalizeChatImagePrompt(prompt, fallbackPrompt) {
    const text = String(prompt || '').trim();
    const fallback = String(fallbackPrompt || '').trim();
    const raw = text || fallback;
    if (!raw) return '';

    const stripped = raw
        .replace(/^```[\s\S]*?\n/, '')
        .replace(/\n```$/g, '')
        .replace(/^分析结果[：:\s]*/g, '')
        .replace(/^(生图提示词|Prompt)[：:\s]*/ig, '')
        .replace(/^[-*\d.、)\s]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return stripped || fallback;
}

const CHAT_IMAGE_RATIO_OPTIONS = ['auto', '1:1', '2:3', '3:2', '4:3', '5:4', '16:9', '3:4', '4:5', '9:16', '21:9'];
const CHAT_IMAGE_SIZE_OPTIONS = ['1K', '2K', '4K'];
const CHAT_IMAGE_REFERENCE_POLICIES = ['no_reference', 'use_reference', 'analyze_only'];

function clampChatImageCount(value, fallback = 1) {
    const num = parseInt(value, 10);
    if (!Number.isFinite(num)) return Math.max(1, Math.min(8, fallback || 1));
    return Math.max(1, Math.min(8, num));
}

function sanitizeChatAspectRatio(value, fallback = 'auto') {
    const raw = String(value || '').trim();
    if (CHAT_IMAGE_RATIO_OPTIONS.includes(raw)) return raw;
    return CHAT_IMAGE_RATIO_OPTIONS.includes(fallback) ? fallback : 'auto';
}

function sanitizeChatImageSize(value, fallback = '1K') {
    const raw = String(value || '').trim().toUpperCase();
    if (CHAT_IMAGE_SIZE_OPTIONS.includes(raw)) return raw;
    const safeFallback = String(fallback || '1K').trim().toUpperCase();
    return CHAT_IMAGE_SIZE_OPTIONS.includes(safeFallback) ? safeFallback : '1K';
}

function sanitizeChatReferencePolicy(value, fallback = 'no_reference') {
    const raw = String(value || '').trim();
    if (CHAT_IMAGE_REFERENCE_POLICIES.includes(raw)) return raw;
    return CHAT_IMAGE_REFERENCE_POLICIES.includes(fallback) ? fallback : 'no_reference';
}

function normalizeChatKeywordEntries(keywords, fallbackPrompt, fallbackCount = 1) {
    const source = Array.isArray(keywords) ? keywords : [];
    const cleaned = source.map((item, index) => {
        if (typeof item === 'string') {
            const prompt = normalizeChatImagePrompt(item, fallbackPrompt);
            if (!prompt) return null;
            return { title: `方案 ${index + 1}`, prompt };
        }
        if (!item || typeof item !== 'object') return null;
        const prompt = normalizeChatImagePrompt(item.prompt || item.keyword || item.text, fallbackPrompt);
        if (!prompt) return null;
        const title = String(item.title || item.name || `方案 ${index + 1}`).trim() || `方案 ${index + 1}`;
        return { title, prompt };
    }).filter(Boolean);
    const count = clampChatImageCount(fallbackCount || cleaned.length || 1, 1);

    if (cleaned.length > 0) {
        const normalized = cleaned.slice(0, Math.min(8, count));
        while (normalized.length < count) {
            const last = normalized[normalized.length - 1] || cleaned[cleaned.length - 1];
            normalized.push({
                title: `方案 ${normalized.length + 1}`,
                prompt: last?.prompt || normalizeChatImagePrompt(fallbackPrompt, '根据描述生成图片')
            });
        }
        return normalized;
    }

    const prompt = normalizeChatImagePrompt(fallbackPrompt, '根据描述生成图片');
    return Array.from({ length: count }, (_, index) => ({
        title: `方案 ${index + 1}`,
        prompt
    }));
}

function buildChatAnalysisSummaryText(plan, fallbackPrompt) {
    const analysis = plan && typeof plan.analysis === 'object' ? plan.analysis : {};
    const lines = [];
    if (analysis.subject) lines.push(`- 主体：${String(analysis.subject).trim()}`);
    if (analysis.scene) lines.push(`- 场景：${String(analysis.scene).trim()}`);
    if (analysis.composition) lines.push(`- 构图：${String(analysis.composition).trim()}`);
    if (analysis.lighting) lines.push(`- 色彩/光线：${String(analysis.lighting).trim()}`);
    if (analysis.style) lines.push(`- 风格/质感：${String(analysis.style).trim()}`);

    // 只返回分析结果，不包含关键词（关键词由 sendChatMessage 统一展示，避免重复）
    const summary = String(plan?.responseText || '').trim();
    const parts = [];
    if (summary) parts.push(summary);
    if (lines.length > 0) parts.push(`分析结果：\n${lines.join('\n')}`);
    return parts.join('\n\n').trim();
}

function normalizeChatImageIntent(intent, userMessage) {
    if (!intent) return null;
    const text = String(userMessage?.content || '').trim();
    const hasImages = Array.isArray(userMessage?.images) && userMessage.images.length > 0;
    const mode = intent.mode;
    if (!mode || mode === 'non_image') return null;
    // hint_upload 模式直接透传，不走标准化流程
    if (mode === 'hint_upload') return intent;

    const fallbackPrompt = hasImages ? '根据参考图生成图片' : '根据描述生成图片';
    const agent = parseChatImageAgentInput(text || fallbackPrompt);
    const paramHint = extractChatImageParams(
        text || fallbackPrompt,
        'auto',
        '1K',
        document.getElementById('chatAspectRatioSelect')?.value || 'auto',
        document.getElementById('chatImageSizeSelect')?.value || '1K'
    );
    const prompt = normalizeChatImagePrompt(intent.prompt, text || fallbackPrompt);
    const defaultReferencePolicy = mode === 'image_to_image'
        ? 'use_reference'
        : (mode === 'analyze_to_text2img' ? 'analyze_only' : 'no_reference');
    const aspectRatio = sanitizeChatAspectRatio(intent.aspectRatio, sanitizeChatAspectRatio(paramHint.ratio, 'auto'));
    const size = sanitizeChatImageSize(intent.size, sanitizeChatImageSize(paramHint.size, '1K'));
    const referencePolicy = sanitizeChatReferencePolicy(intent.referencePolicy, defaultReferencePolicy);
    const count = clampChatImageCount(intent.count || intent.keywords?.length || agent.count || 1, agent.count || 1);
    const negativePrompt = normalizeChatImagePrompt(intent.negativePrompt, '');
    const keywords = normalizeChatKeywordEntries(intent.keywords, prompt || fallbackPrompt, count);

    return {
        ...intent,
        mode,
        prompt: prompt || fallbackPrompt,
        hasImages,
        count,
        aspectRatio,
        size,
        negativePrompt,
        referencePolicy,
        keywords,
        reason: String(intent.reason || '').trim(),
        source: intent.source || 'heuristic'
    };
}

async function resolveChatImageIntent(chat, userMessage) {
    // 优先检测用户明确指定的模式（关键词命中，source: 'user_override'）
    const heuristic = detectChatImageIntent(userMessage?.content, userMessage?.images);
    if (heuristic && heuristic.source === 'user_override') {
        // hint_upload 模式直接返回，不走生图流程
        if (heuristic.mode === 'hint_upload') return heuristic;
        // 其他用户指定模式，直接使用，跳过AI判断
        return normalizeChatImageIntent(heuristic, userMessage);
    }

    // 没有明确关键词时，走AI判断
    const hasImages = Array.isArray(userMessage?.images) && userMessage.images.length > 0;
    let modelIntent = null;
    if (hasImages) {
        try {
            modelIntent = await classifyChatImageIntentWithChatModel(chat, userMessage);
        } catch (err) {
            debugWarn('classifyChatImageIntentWithChatModel failed:', err);
        }
        if (modelIntent?.mode === 'non_image') return null;
        const normalizedModelIntent = normalizeChatImageIntent(modelIntent, userMessage);
        if (normalizedModelIntent) return normalizedModelIntent;
    }

    // AI判断也失败时，用启发式结果兜底
    return normalizeChatImageIntent(heuristic, userMessage);
}

async function submitChatImageTask(chat, userMessage, intent) {
    const tokenInput = document.getElementById('token');
    const drawApiBaseInput = document.getElementById('drawApiBase');
    const token = tokenInput?.value?.trim();
    if (!token) throw new Error('请先填写 API Token');

    const apiBase = drawApiBaseInput?.value?.trim() || getDefaultDrawApiBase();
    const model = getChatImageModelId();
    const isGPTImage2 = isGPTImage2Model(model);
    const submitUrl = `${apiBase.replace(/\/$/, '')}${isGPTImage2 ? '/v1/draw/completions' : '/v1/draw/nano-banana'}`;
    const resultUrl = `${apiBase.replace(/\/$/, '')}/v1/draw/result`;
    const paramHint = extractChatImageParams(
        intent?.prompt || userMessage.content,
        document.getElementById('aspectRatio')?.value || 'auto',
        document.getElementById('imageSizeSelect')?.value || '1K',
        document.getElementById('chatAspectRatioSelect')?.value || 'auto',
        document.getElementById('chatImageSizeSelect')?.value || '1K'
    );
    const inferredRatio = await inferChatImageAspectRatio(intent?.prompt || userMessage.content, userMessage.images, intent);
    const aspectRatio = sanitizeChatAspectRatio(intent?.aspectRatio, sanitizeChatAspectRatio(paramHint.ratio, inferredRatio || '1:1'));
    const imageSize = sanitizeChatImageSize(intent?.size, sanitizeChatImageSize(paramHint.size, '1K'));
    const prompt = intent.prompt || userMessage.content || '根据参考图生成图片';
    const negativePrompt = normalizeChatImagePrompt(intent?.negativePrompt, '');
    const referencePolicy = sanitizeChatReferencePolicy(
        intent?.referencePolicy,
        intent?.mode === 'image_to_image' ? 'use_reference' : (intent?.mode === 'analyze_to_text2img' ? 'analyze_only' : 'no_reference')
    );
    const shouldSendRefs = referencePolicy === 'use_reference';
    const referenceUrls = shouldSendRefs && Array.isArray(userMessage.images) ? userMessage.images.map(img => img.data || img.url).filter(Boolean) : [];
    const maxAttempts = 150;
    let failureReason = '';
    const modelMetaMap = {
        'nano-banana-fast': { label: 'nano-banana-fast', defaultSize: '1K' },
        'nano-banana-2': { label: 'nano-banana-2', defaultSize: '1K' },
        'nano-banana-pro': { label: 'nano-banana-pro', defaultSize: '2K' },
        'nano-banana-pro-vip': { label: 'nano-banana-pro-vip', defaultSize: '2K' },
        'nano-banana-pro-4k-vip': { label: 'nano-banana-pro-4k-vip', defaultSize: '4K' },
        'GPT Image-2': { label: 'GPT Image-2', defaultSize: '1K' },
        'gpt-image-2-vip': { label: 'gpt-image-2-vip', defaultSize: '1K' }
    };
    const modelInfo = modelMetaMap[model] || { label: model, defaultSize: '1K' };
    const sizeToPixels = { '1K': '1024×1024', '2K': '2048×2048', '4K': '4096×4096' };
    const imageMeta = `模型：${modelInfo.label} · 比例：${aspectRatio} · 像素：${sizeToPixels[imageSize] || sizeToPixels[modelInfo.defaultSize] || '1024×1024'}`;

    const payload = isGPTImage2 ? {
        model: model === 'gpt-image-2-vip' ? 'gpt-image-2-vip' : 'gpt-image-2',
        prompt,
        size: calculateGPTImage2Size(imageSize, aspectRatio),
        quality: model === 'gpt-image-2-vip' ? (GPT_IMAGE2_QUALITY_MAP[imageSize] || 'low') : undefined,
        negativePrompt: negativePrompt || undefined,
        urls: referenceUrls,
        webHook: '-1',
        shutProgress: false
    } : {
        model,
        prompt,
        aspectRatio,
        imageSize,
        negativePrompt: negativePrompt || undefined,
        urls: referenceUrls,
        webHook: '-1',
        shutProgress: true
    };

    const response = await fetch(submitUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`提交图片任务失败: HTTP ${response.status}${errorText ? ` - ${errorText.slice(0, 300)}` : ''}`);
    }

    const submitData = await response.json();
    if (submitData.code !== 0 || !submitData.data?.id) throw new Error(submitData.msg || '提交图片任务失败');
    const taskId = submitData.data.id;

    let imageUrl = parseImageFromResponse(submitData.data?.results?.[0] || submitData.data);
    for (let attempt = 0; attempt < maxAttempts && !imageUrl; attempt++) {
        await new Promise(r => setTimeout(r, 1000));
        const resultResponse = await fetch(resultUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ id: taskId })
        });
        if (!resultResponse.ok) {
            const resultErrorText = await resultResponse.text().catch(() => '');
            failureReason = `查询图片结果失败: HTTP ${resultResponse.status}${resultErrorText ? ` - ${resultErrorText.slice(0, 300)}` : ''}`;
            continue;
        }
        const resultData = await resultResponse.json();
        if (resultData.code !== 0) {
            if (resultData.msg || resultData.message) failureReason = resultData.msg || resultData.message;
            continue;
        }
        const data = resultData.data;
        if (data?.status === 'failed') {
            failureReason = data?.message || data?.error || data?.reason || '图片生成失败';
            break;
        }
        imageUrl = parseImageFromResponse(data?.results?.[0] || data);
        if (!imageUrl && data?.message) failureReason = data.message;
    }

    if (imageUrl) {
        let cleanedUrl = String(imageUrl || '').trim();
        const actualPixels = await getImageNaturalPixels(cleanedUrl);
        
        // 自动接入本地落盘服务：对话模式单图在生成完第一秒立即写入物理磁盘并清洗 Base64！
        if (StorageAdapter.isServer() && (cleanedUrl.startsWith('data:image/') || cleanedUrl.startsWith('http'))) {
            try {
                const recordToSave = {
                    id: Date.now() + '-' + Math.floor(Math.random() * 1000),
                    type: 'image',
                    prompt: intent?.prompt || '',
                    timestamp: Date.now(),
                    clientId: localStorage.getItem('clientId') || '',
                    username: localStorage.getItem('username') || '',
                    mode: 'chat',
                    chatName: chat?.title || '未命名对话',
                    imageData: cleanedUrl,
                    fileData: Array.isArray(userMessage?.images) ? userMessage.images.map((img, idx) => ({
                        name: img.originalName || `ref_${idx + 1}.png`,
                        type: 'image/png',
                        data: img.previewData || img.data || ''
                    })).filter(img => img.data && img.data.startsWith('data:image/')) : []
                };
                const res = await fetch('/api/save-image', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(recordToSave)
                });
                const resData = await res.json();
                if (resData && resData.url) {
                    cleanedUrl = resData.url;
                }
            } catch (e) {
                console.error('❌ 保存对话消息单张图片落盘失败:', e);
            }
        }
        
        return { status: 'success', imageUrl: cleanedUrl, taskId, imageMeta, actualPixels };
    }
    return { status: 'failed', taskId, reason: failureReason || '生图超时，请重试' };
}

// 格式化用户消息时间戳
function formatChatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatChatImageErrorReason(reason) {
    let text = reason instanceof Error ? reason.message : String(reason || '').trim();
    if (!text) return '图片生成失败';
    try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            text = parsed?.error?.message || parsed?.message || parsed?.msg || text;
        }
    } catch (_) {}
    const lower = text.toLowerCase();
    let hint = '';
    if (/\b401\b|unauthorized|invalid api key|invalid token|token/.test(lower)) hint = 'Token 无效或未授权';
    else if (/\b402\b|quota|balance|insufficient|credit|余额|额度/.test(lower)) hint = '额度不足或余额不足';
    else if (/\b403\b|forbidden|permission|权限/.test(lower)) hint = '权限不足或被拒绝';
    else if (/\b429\b|rate limit|too many requests|频率|限流/.test(lower)) hint = '请求过快或触发限流';
    else if (/policy|safety|violation|blocked|违规|敏感|安全/.test(lower)) hint = '内容可能触发安全策略';
    else if (/timeout|timed out|超时/.test(lower)) hint = '任务超时';
    const compact = text.replace(/\s+/g, ' ').trim();
    const clipped = compact.length > 180 ? compact.slice(0, 180) + '…' : compact;
    return hint && !compact.includes(hint) ? `${hint}（${clipped}）` : clipped;
}

function getChatImageSizePixels(imageSize, aspectRatio) {
    const resolution = calculateTargetResolution(imageSize || '1K', aspectRatio || '1:1');
    if (!resolution || !resolution.width || !resolution.height) return '';
    return `${Math.round(resolution.width)} × ${Math.round(resolution.height)}`;
}

function getImageNaturalPixels(src) {
    return new Promise(resolve => {
        if (!src) return resolve('');
        const img = new Image();
        img.onload = () => {
            const w = Number(img.naturalWidth || 0);
            const h = Number(img.naturalHeight || 0);
            if (w > 0 && h > 0) return resolve(`${w} × ${h}`);
            return resolve('');
        };
        img.onerror = () => resolve('');
        img.src = src;
    });
}

function extractChatImageParams(text, defaultRatio = 'auto', defaultSize = '1K', chatRatio = 'auto', chatSize = '1K') {
    const raw = String(text || '');
    const lower = raw.toLowerCase();
    
    // 比例识别：支持 4:3、4比3、4比3、比例4:3、ratio 4:3 等格式
    const ratioPatterns = [
        { regex: /(\d+)\s*[:：]\s*(\d+)/g, format: (m) => `${m[1]}:${m[2]}` },  // 4:3、4：3
        { regex: /(\d+)\s*比\s*(\d+)/g, format: (m) => `${m[1]}:${m[2]}` },    // 4比3
        { regex: /比例\s*(\d+)\s*[:：]?\s*(\d+)/gi, format: (m) => `${m[1]}:${m[2]}` },  // 比例4:3
        { regex: /ratio\s*(\d+)\s*[:：]?\s*(\d+)/gi, format: (m) => `${m[1]}:${m[2]}` },  // ratio 4:3
    ];
    const validRatios = ['1:1', '2:3', '3:2', '4:3', '5:4', '16:9', '3:4', '4:5', '9:16', '21:9', '1:2', '2:1', '9:21', '3:1', '1:3'];
    const ratioKeywords = [
        { kw: '竖图', value: '3:4' },
        { kw: '竖屏', value: '9:16' },
        { kw: '竖版', value: '3:4' },
        { kw: '横图', value: '16:9' },
        { kw: '横屏', value: '16:9' },
        { kw: '横版', value: '3:2' },
        { kw: '方图', value: '1:1' },
        { kw: '正方形', value: '1:1' },
    ];
    
    // 尺寸识别：支持 1K、1k、1024、1024x1024、2k、4k 等
    const sizePatterns = [
        { regex: /\b(1|2|4)[kK]\b/g, format: (m) => `${m[1]}K` },  // 1K、2K、4K
        { regex: /\b(1024|2048|4096)\s*x\s*(1024|2048|4096)\b/gi, format: (m) => m[1] === '1024' ? '1K' : (m[1] === '2048' ? '2K' : '4K') },  // 1024x1024
        { regex: /尺寸\s*(\d+)\s*[kK]?/gi, format: (m) => {
            const n = parseInt(m[1]);
            return n >= 2048 ? '4K' : (n >= 1024 ? '2K' : '1K');
        }},
        { regex: /size\s*(\d+)\s*[kK]?/gi, format: (m) => {
            const n = parseInt(m[1]);
            return n >= 2048 ? '4K' : (n >= 1024 ? '2K' : '1K');
        }},
    ];
    const sizeKeywords = [
        { kw: '超清', value: '4K' },
        { kw: '高清', value: '2K' },
        { kw: '清晰点', value: '2K' },
        { kw: '高分辨率', value: '4K' },
        { kw: '4k', value: '4K' },
        { kw: '2k', value: '2K' },
        { kw: '1k', value: '1K' },
    ];

    // 提取比例
    let ratio = null;
    for (const pattern of ratioPatterns) {
        const matches = [...raw.matchAll(pattern.regex)];
        for (const match of matches) {
            const formatted = pattern.format(match);
            if (validRatios.includes(formatted)) {
                ratio = formatted;
                break;
            }
        }
        if (ratio) break;
    }
    // 如果没匹配到，尝试关键词
    if (!ratio) {
        const ratioKeyword = ratioKeywords.find(item => raw.includes(item.kw) || lower.includes(item.kw.toLowerCase()));
        if (ratioKeyword) ratio = ratioKeyword.value;
    }
    // 最终 fallback
    if (!ratio || ratio === 'auto') {
        ratio = chatRatio && chatRatio !== 'auto' ? chatRatio : (defaultRatio || 'auto');
    }

    // 提取尺寸
    let size = null;
    for (const pattern of sizePatterns) {
        const matches = [...raw.matchAll(pattern.regex)];
        for (const match of matches) {
            size = pattern.format(match);
            break;
        }
        if (size) break;
    }
    // 如果没匹配到，尝试关键词
    if (!size) {
        const sizeKeyword = sizeKeywords.find(item => lower.includes(item.kw.toLowerCase()));
        if (sizeKeyword) size = sizeKeyword.value;
    }
    // 最终 fallback
    if (!size || size === '1K') {
        size = chatSize && chatSize !== '1K' ? chatSize : (defaultSize || '1K');
    }

    return { ratio: ratio || 'auto', size: size || '1K' };
}

function classifyChatPromptType(text) {
    const raw = String(text || '');
    const lower = raw.toLowerCase();
    const strongLayoutSignals = [
        '区域', '分区', '上中下', '三栏', 'a+页面', 'a+ 页面', '详情页', 'ui', '模块', '分隔线', '导航栏', '卡片', 'grid', 'section'
    ];
    const hasStrongLayout = strongLayoutSignals.some(k => raw.includes(k) || lower.includes(k.toLowerCase()));
    const hasContextualLayout = /(页面|详情页|a\+\s*页面|ui|模块|区域|分区|上中下|三栏|左右|导航栏|卡片).{0,8}(布局|版式|layout)|(布局|版式|layout).{0,8}(页面|详情页|a\+\s*页面|ui|模块|区域|分区|上中下|三栏|左右|导航栏|卡片)/i.test(raw);
    const hasInternalRatio = /(上中下|左右|区域|分区|模块|三栏|顶部|中间|底部|左侧|右侧|上下|左中右).{0,12}(比例|占比|占\s*\d+%|\d+\s*[:：]\s*\d+)|((比例|占比|占\s*\d+%).{0,12}(上中下|左右|区域|分区|模块|三栏|顶部|中间|底部|左侧|右侧|上下|左中右))/i.test(raw);
    const isLayout = hasStrongLayout || hasContextualLayout || hasInternalRatio;
    const productSignals = [
        '产品图', '商品图', '主图', '白底', '电商', '包装', '瓶子', '罐子', '盒子', '产品摄影', '商品摄影', '正面视角', '侧面视角', '透明背景', '纯色背景', '棚拍', '静物'
    ];
    const isProduct = !isLayout && productSignals.some(k => raw.includes(k) || lower.includes(k.toLowerCase()));
    const promptType = isLayout ? 'layout' : (isProduct ? 'product' : 'creative');
    const rewriteMode = isLayout ? 'preserve' : (isProduct ? 'conservative' : 'enhance');
    return {
        promptType,
        rewriteMode,
        rewriteEnabled: !isLayout,
        preserveStructure: isLayout,
        preserveSubject: isLayout || isProduct
    };
}

function buildChatImageMetaText(intent, imageSize, aspectRatio, actualPixels = '') {
    const model = intent?.model || getChatImageModelId();
    const ratio = aspectRatio || intent?.aspectRatio || 'auto';
    const fallbackPixel = getChatImageSizePixels(imageSize || '1K', ratio);
    const pixel = actualPixels || fallbackPixel;
    return [
        model ? `模型：${model}` : '',
        ratio ? `比例：${ratio}` : '',
        pixel ? `像素：${pixel}` : ''
    ].filter(Boolean).join(' · ');
}


function appendChatImageMessage(chat, userMessage, result, summaryText, intent) {
    const resolvedIntent = normalizeChatImageIntent(intent || detectChatImageIntent(userMessage.content, userMessage.images), userMessage) || {
        mode: 'text_to_image',
        prompt: normalizeChatImagePrompt(userMessage.content, '根据描述生成图片'),
        hasImages: Array.isArray(userMessage.images) && userMessage.images.length > 0,
        source: 'fallback'
    };
    const imageSize = resolvedIntent.size || '1K';
    const aspectRatio = resolvedIntent.aspectRatio || 'auto';
    const metaText = buildChatImageMetaText(resolvedIntent, imageSize, aspectRatio, result?.actualPixels || '');

    if (!result || result.status === 'failed') {
        chat.messages.push({
            role: 'ai',
            content: `生图失败：${formatChatImageErrorReason(result?.reason || '图片生成失败')}`,
            error: true,
            imageTask: {
                prompt: resolvedIntent.prompt,
                images: Array.isArray(userMessage.images) ? userMessage.images.map(img => ({ ...img })) : [],
                intent: resolvedIntent
            },
            timestamp: Date.now()
        });
        return;
    }

    chat.messages.push({
        role: 'ai',
        content: summaryText || '已根据你的需求生成图片。',
        images: [{ data: result.imageUrl, previewData: result.imageUrl, taskId: result.taskId || '', source: 'generated', prompt: resolvedIntent.prompt || '' }],
        imageMeta: metaText,
        imageLayout: 'single',
        timestamp: Date.now()
    });
}

async function inferChatImageAspectRatio(text, images, intent) {
    const raw = String(text || '').toLowerCase();
    if (raw.includes('9:16') || raw.includes('手机壁纸') || raw.includes('竖屏')) return '9:16';
    if (raw.includes('16:9') || raw.includes('横幅') || raw.includes('banner') || raw.includes('横版')) return '16:9';
    if (raw.includes('4:5') || raw.includes('小红书') || raw.includes('电商主图')) return '4:5';
    if (raw.includes('3:4') || raw.includes('海报') || raw.includes('封面') || raw.includes('竖版')) return '3:4';
    if (raw.includes('1:1') || raw.includes('头像') || raw.includes('方图')) return '1:1';

    if ((intent?.mode === 'analyze_to_text2img' || intent?.mode === 'image_to_image') && Array.isArray(images) && images.length > 0) {
        const ratio = await getChatImageRatio(images[0]?.data || images[0]?.url);
        if (ratio) return ratio;
    }

    return '1:1';
}

function getChatImageRatio(src) {
    return new Promise(resolve => {
        if (!src) return resolve(null);
        const img = new Image();
        img.onload = () => {
            const w = img.naturalWidth || 1;
            const h = img.naturalHeight || 1;
            if (!w || !h) return resolve(null);
            const ratio = w / h;
            if (ratio > 1.55) return resolve('16:9');
            if (ratio > 1.22) return resolve('4:3');
            if (ratio > 0.88) return resolve('1:1');
            if (ratio > 0.72) return resolve('3:4');
            if (ratio > 0.58) return resolve('2:3');
            return resolve('9:16');
        };
        img.onerror = () => resolve(null);
        img.src = src;
    });
}

function parseChatImageAgentInput(rawText) {
    const text = String(rawText || '').trim();
    const cnNumMap = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    const digitMatch = text.match(/(?:生成|做|出|来|给我|要|整|弄|共|总共)?\s*(\d+)\s*(?:张|个|幅|套|版)/);
    const cnMatch = text.match(/(?:生成|做|出|来|给我|要|整|弄|共|总共)?\s*([一二两三四五六七八九十])\s*(?:张|个|幅|套|版)/);
    const rawCount = digitMatch ? parseInt(digitMatch[1], 10) : (cnMatch ? (cnNumMap[cnMatch[1]] || 1) : null);
    const count = rawCount ? Math.max(1, Math.min(8, rawCount)) : (/(几张|多张|多来几张)/.test(text) ? 2 : 1);

    const cleaned = text
        .replace(/^(?:请|麻烦|帮我|给我|给|来|做|弄|整)?\s*(?:生成|做|出|画|绘制|创建|设计)?\s*/g, '')
        .replace(/(?:共|总共|一共)?\s*(?:\d+|[一二两三四五六七八九十])\s*(?:张|个|幅|套|版)/g, ' ')
        .replace(/(?:图片|图像|图|照片|壁纸)(?:\s*即可|\s*就行)?/g, ' ')
        .replace(/^(?:一张|两张|三张|四张|五张)\s*/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^[,，。；;:：\-\s]+|[,，。；;:：\-\s]+$/g, '')
        .trim();

    return {
        count,
        scenePrompt: cleaned || text || '根据描述生成图片'
    };
}

function buildChatImagePrompt(intent, userMessage) {
    const text = String(userMessage?.content || '').trim();
    const hasImages = Array.isArray(userMessage?.images) && userMessage.images.length > 0;
    const agent = parseChatImageAgentInput(text);

    if (intent?.mode === 'analyze_to_text2img') {
        return text || '分析参考图风格，并生成一张类似风格的新图';
    }
    if (intent?.mode === 'image_to_image' && hasImages) {
        return text || '基于参考图进行图生图改图';
    }
    return agent.scenePrompt || text || '根据描述生成图片';
}

function buildChatReuseText(msg) {
    const parts = [];
    if (msg?.content) parts.push(msg.content);
    return parts.join('\n\n');
}

function extractJsonObject(text) {
    const raw = String(text || '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(raw.slice(start, end + 1));
    } catch (_) {
        return null;
    }
}

async function classifyChatImageIntentWithChatModel(chat, userMessage) {
    const modelSelect = document.getElementById('chatModelSelect');
    const config = resolveChatApiConfig(modelSelect?.value);
    if (!config.token) return null;

    const hasImages = Array.isArray(userMessage?.images) && userMessage.images.length > 0;
    if (!hasImages) return null;

    const content = await buildMessageContentForApi({
        content: `请先判断用户这条消息是不是图片需求，只返回 JSON。

可选 mode 只有四种：
- non_image：不是图片需求，继续普通对话
- image_to_image：改图/修图/换背景/改头发/局部修改/保留原图
- analyze_to_text2img：先分析参考图，再根据分析结果生成一张或多张类似风格的新图
- text_to_image：只根据文字描述直接生成新图

请输出格式（严格 JSON，不要附加任何解释）：
{"mode":"non_image|image_to_image|analyze_to_text2img|text_to_image","reason":"简短原因","prompt":"整理后的生图提示词或空字符串","count":1,"aspectRatio":"auto|1:1|2:3|3:2|4:3|5:4|16:9|3:4|4:5|9:16|21:9","size":"1K|2K|4K","negativePrompt":"可选，负向约束","referencePolicy":"no_reference|use_reference|analyze_only"}

判断要求：
1. 先判断是不是图片需求，不是就输出 non_image。
2. 如果用户明显在修改原图，选 image_to_image。
3. 如果用户要先分析图片风格，再生成类似风格的新图，选 analyze_to_text2img。
4. 如果用户只是基于文字描述生成图片，选 text_to_image。
5. 如果用户给了图片但只是问答，不要硬判成图片需求，优先 non_image。
6. count 是生成张数（1-8），从用户文本里提取；若未明确写数量，默认 1。
7. prompt 只写可直接送入生图模型的整理结果，不要保留“生成2张/来几张/图片”等控制词。

用户消息：${userMessage.content || ''}`,
        images: userMessage.images || []
    }, true);

    const contextMessages = await buildApiContextMessages('你是一个严格的图片任务意图分类器，只能输出 JSON。参考对话历史理解用户意图。', chat, true);
    contextMessages.push({ role: 'user', content });

    const response = await fetch(`${config.apiBase.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.token}`
        },
        body: JSON.stringify({
            model: config.modelId,
            stream: false,
            messages: contextMessages
        })
    });

    if (!response.ok) return null;

    const data = await response.json().catch(() => null);
    const text = (parseTextFromResponse(data) || '').trim();
    const parsed = extractJsonObject(text);
    if (!parsed || !parsed.mode) return null;

    const mode = ['non_image', 'image_to_image', 'analyze_to_text2img', 'text_to_image'].includes(parsed.mode) ? parsed.mode : null;
    if (!mode) return null;
    return {
        mode,
        reason: String(parsed.reason || '').trim(),
        prompt: String(parsed.prompt || '').trim(),
        count: clampChatImageCount(parsed.count || 1, 1),
        aspectRatio: sanitizeChatAspectRatio(parsed.aspectRatio, 'auto'),
        size: sanitizeChatImageSize(parsed.size, '1K'),
        negativePrompt: String(parsed.negativePrompt || '').trim(),
        referencePolicy: sanitizeChatReferencePolicy(parsed.referencePolicy, mode === 'image_to_image' ? 'use_reference' : (mode === 'analyze_to_text2img' ? 'analyze_only' : 'no_reference')),
        hasImages: true,
        source: 'model'
    };
}

// ========== 新流程：轻量分流 ==========
// 只判断 CHAT / IMAGE_TASK，不做任何回答
async function classifyChatIntent(chat, userMessage) {
    const text = String(userMessage?.content || '').trim();
    const hasImages = Array.isArray(userMessage?.images) && userMessage.images.length > 0;
    const lower = text.toLowerCase();

    // ==================== 【直通通道 A：确定性的生图指令】 ====================
    const forceImageKeywords = ['文生图', '图生图', '纯文生图', '不分析', '忽略参考图', '不用参考图'];
    const isExplicitGen = /^(画|生成|出图|绘制|设计)\s*/.test(text) 
        || forceImageKeywords.some(k => text.includes(k));

    if (isExplicitGen) {
        return 'IMAGE_TASK'; // 🚀 0ms 瞬间直通第二步（Plan），免去第一步的 API 延迟与资费！
    }

    // ==================== 【直通通道 B：绝对安全的极简闲聊】 ====================
    const pureChatShortcuts = ['你好', '在吗', 'hello', 'hi', '谢谢', '再见', '早安', '晚上好', '哈哈', 'ok', '好的'];
    if (!hasImages && pureChatShortcuts.includes(lower)) {
        return 'CHAT'; // 🚀 0ms 瞬间直通普通对话，你好/谢谢秒回，彻底消除 1.5 秒空等延迟！
    }

    const modelSelect = document.getElementById('chatModelSelect');
    const config = resolveChatApiConfig(modelSelect?.value);
    if (!config.token) return 'CHAT';
    const content = await buildMessageContentForApi({
        content: '判断用户意图是否与图像相关（包括：生成图片、编辑图片、优化生图关键词、分析图片风格、根据参考图生成新图等）。\n\n如果与图像相关，只回复 IMAGE_TASK\n如果只是普通对话、闲聊、提问，只回复 CHAT\n\n只回复这两个词之一，不要回复其他内容。',
        images: userMessage.images || []
    }, true);

    const contextMessages = await buildApiContextMessages('你是一个意图分类器，只输出 IMAGE_TASK 或 CHAT。', chat, true);
    contextMessages.push({ role: 'user', content });

    try {
        const response = await fetch(`${config.apiBase.replace(/\/$/, '')}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.token}`
            },
            body: JSON.stringify({
                model: config.modelId,
                stream: false,
                messages: contextMessages
            })
        });
        if (!response.ok) return 'CHAT';
        const data = await response.json().catch(() => null);
        const text = (parseTextFromResponse(data) || '').trim().toUpperCase();
        return text.includes('IMAGE_TASK') ? 'IMAGE_TASK' : 'CHAT';
    } catch (_) {
        return 'CHAT';
    }
}

// ========== 新流程：深度构思 ==========
// 让模型自由分析文字+图片，输出 understanding / plan / mode / keywords
async function deepPlanImageRequest(chat, userMessage) {
    const modelSelect = document.getElementById('chatModelSelect');
    const config = resolveChatApiConfig(modelSelect?.value);
    const fallbackPrompt = userMessage.content || '根据描述生成图片';

    if (!config.token) {
        return {
            understanding: '',
            plan: '',
            mode: 'text_to_image',
            keywords: [fallbackPrompt],
            count: 1,
            referencePolicy: 'no_reference',
            responseText: ''
        };
    }

    const userSelectedRatio = document.getElementById('chatAspectRatioSelect')?.value || 'auto';
    const userSelectedSize = document.getElementById('chatImageSizeSelect')?.value || '1K';

    const imgCount = Array.isArray(userMessage.images) ? userMessage.images.length : 0;
    const imgHint = imgCount > 0 ? `\n\n用户本次上传了 ${imgCount} 张图片。请先逐一观察每张图片的内容，理解每张图分别是什么。在 understanding 中说明每张图的内容，在 plan 中明确每张图如何使用，不得遗漏任何一张。` : '';

    const content = await buildMessageContentForApi({
        content: `你是一个专业的视觉创意专家。用户向你提出了一个图像相关的需求，请完成以下任务。

首先，请仔细观察用户提供的所有图片和文字，进行自由构思。
然后，将你的构思整理成以下 JSON 格式输出。

请严格按此 JSON 结构返回，不要包含任何其他内容：

{
  "understanding": "用简短的中文，描述你理解到的用户需求。包括：用户提供了什么、每张图分别是什么、想要什么效果。",
  "plan": "用简短的中文，描述你构思的设计方案。包括：新图片里会有什么动作、场景、构图、排版思路。如果用户提供了多张素材图，必须逐一说明每张图如何使用，不得遗漏。",
  "mode": "text_to_image 或 image_to_image 或 analyze_only",
  "keywords": ["英文生图关键词1", "英文生图关键词2"],
  "count": 1,
  "aspectRatio": "auto",
  "size": "1K",
  "negativePrompt": "",
  "referencePolicy": "no_reference"
}

注意：
- mode 判断规则：
  * image_to_image：用户提供了图片，且要求基于原图的主体（人物、物品等）生成新图（换动作、换场景、换风格但保留主体特征）。参考图要传给生图模型。
  * analyze_to_text2img：用户提供了参考图，想分析其风格后生成类似风格的新图（不需要保留原图主体）。只分析参考图，不传给生图模型。
  * text_to_image：用户只用文字描述需求，或者提供的图片只是风格参考（不需要保留图片内的具体主体）。
  * analyze_only：用户只是想分析图片、优化关键词，不需要真正生图。
- keywords 是数组，每个元素是一句完整的英文生图提示词，包含主体、动作、场景、风格、光影、构图等细节。如果是图生图，需要明确描述要保留原图的什么、改变什么。
- 如果用户只需要生成1张图，keywords 数组只有1个元素。如果用户要多张，keywords 数组有多个元素。
- count 是生成张数，与 keywords 数组长度一致。
- aspectRatio 默认 "${userSelectedRatio}"，size 默认 "${userSelectedSize}"，除非用户文字里明确指定了其他值。
- referencePolicy：image_to_image 时为 "use_reference"，analyze_to_text2img 时为 "analyze_only"，text_to_image 时为 "no_reference"。
- understanding 和 plan 请用中文，让用户能看懂。

用户消息：${userMessage.content || '生成图片'}${imgHint}`,
        images: userMessage.images || []
    }, true);

    const contextMessages = await buildApiContextMessages('你是专业的视觉创意专家。参考对话历史理解用户意图，仔细观察用户提供的所有图片，进行自由构思。', chat, true);
    contextMessages.push({ role: 'user', content });

    const response = await fetch(`${config.apiBase.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.token}`
        },
        body: JSON.stringify({
            model: config.modelId,
            stream: false,
            messages: contextMessages
        })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || errorData.message || `图像构思失败: HTTP ${response.status}`);
    }

    const data = await response.json();
    const text = (parseTextFromResponse(data) || '').trim();
    const parsed = extractJsonObject(text);

    if (parsed && (parsed.understanding || parsed.keywords || parsed.mode)) {
        const rawCount = parsed.count || (Array.isArray(parsed.keywords) ? parsed.keywords.length : 1) || 1;
        const normalizedKeywords = normalizeChatKeywordEntries(parsed.keywords, fallbackPrompt, rawCount);
        const keywords = normalizedKeywords.map(item => item.prompt);

        const mode = ['text_to_image', 'image_to_image', 'analyze_to_text2img', 'analyze_only'].includes(parsed.mode)
            ? parsed.mode : 'text_to_image';
        const referencePolicy = sanitizeChatReferencePolicy(
            parsed.referencePolicy,
            mode === 'image_to_image' ? 'use_reference' : (mode === 'analyze_to_text2img' ? 'analyze_only' : 'no_reference')
        );

        return {
            understanding: String(parsed.understanding || '').trim(),
            plan: String(parsed.plan || '').trim(),
            mode,
            keywords,
            count: keywords.length,
            aspectRatio: sanitizeChatAspectRatio(parsed.aspectRatio, userSelectedRatio),
            size: sanitizeChatImageSize(parsed.size, userSelectedSize),
            negativePrompt: normalizeChatImagePrompt(parsed.negativePrompt, ''),
            referencePolicy,
            responseText: ''
        };
    }

    // JSON 解析失败，兜底
    return {
        understanding: '',
        plan: '',
        mode: 'text_to_image',
        keywords: [fallbackPrompt],
        count: 1,
        aspectRatio: userSelectedRatio,
        size: userSelectedSize,
        negativePrompt: '',
        referencePolicy: 'no_reference',
        responseText: ''
    };
}

async function planChatImagePromptWithChatModel(chat, userMessage, intent) {
    const modelSelect = document.getElementById('chatModelSelect');
    const config = resolveChatApiConfig(modelSelect?.value);
    const fallbackPrompt = buildChatImagePrompt(intent, userMessage);
    if (!config.token) {
        const fallbackKeywords = normalizeChatKeywordEntries(intent?.keywords, fallbackPrompt, intent?.count || 1);
        return {
            analysisText: intent?.mode === 'analyze_to_text2img' ? `分析结果：已根据参考图提炼画面风格。\n\n生图提示词：\n${fallbackKeywords.map((item, index) => `${index + 1}. ${item.prompt}`).join('\n')}` : '',
            prompt: fallbackPrompt,
            prompts: fallbackKeywords.map(item => item.prompt),
            keywords: fallbackKeywords,
            count: clampChatImageCount(intent?.count || fallbackKeywords.length || 1, 1),
            aspectRatio: sanitizeChatAspectRatio(intent?.aspectRatio, 'auto'),
            size: sanitizeChatImageSize(intent?.size, '1K'),
            negativePrompt: normalizeChatImagePrompt(intent?.negativePrompt, ''),
            referencePolicy: sanitizeChatReferencePolicy(intent?.referencePolicy, intent?.mode === 'image_to_image' ? 'use_reference' : (intent?.mode === 'analyze_to_text2img' ? 'analyze_only' : 'no_reference')),
            responseText: ''
        };
    }

    const requestCount = clampChatImageCount(intent?.count || intent?.keywords?.length || 1, 1);
    const defaultReferencePolicy = intent?.mode === 'image_to_image'
        ? 'use_reference'
        : (intent?.mode === 'analyze_to_text2img' ? 'analyze_only' : 'no_reference');
    // 用户已选的比例和尺寸（从intent或下拉框获取）
    const selectedAspectRatio = intent?.aspectRatio || document.getElementById('chatAspectRatioSelect')?.value || 'auto';
    const selectedSize = intent?.size || document.getElementById('chatImageSizeSelect')?.value || '1K';
    const promptControl = classifyChatPromptType(userMessage?.content || intent?.prompt || fallbackPrompt);
    if (promptControl.preserveStructure) {
        const fallbackKeywords = normalizeChatKeywordEntries(intent?.keywords, fallbackPrompt, requestCount);
        return {
            analysisText: '',
            prompt: fallbackKeywords[0]?.prompt || fallbackPrompt,
            prompts: fallbackKeywords.map(item => item.prompt),
            keywords: fallbackKeywords,
            count: requestCount,
            aspectRatio: sanitizeChatAspectRatio(intent?.aspectRatio, selectedAspectRatio),
            size: sanitizeChatImageSize(intent?.size, selectedSize),
            negativePrompt: normalizeChatImagePrompt(intent?.negativePrompt, ''),
            referencePolicy: sanitizeChatReferencePolicy(intent?.referencePolicy, defaultReferencePolicy),
            layout: 'single_image',
            responseText: '已识别为布局/页面类需求，将保留原始结构描述，不做自由改写。'
        };
    }
    const content = await buildMessageContentForApi({
        content: `你要把用户的图片需求整理成“下游生图模型可直接执行”的结构化 JSON，只能输出 JSON，不要 Markdown，不要解释。\n\n当前任务模式：${intent?.mode || 'text_to_image'}\n目标出图数量：${requestCount}\n默认参考图策略：${defaultReferencePolicy}\n用户已选比例：${selectedAspectRatio}\n用户已选尺寸：${selectedSize}\nPrompt 类型：${promptControl.promptType}\nRewrite 策略：${promptControl.rewriteMode}\n\n严格输出以下 JSON 结构：\n{"mode":"text_to_image|image_to_image|analyze_to_text2img","responseText":"给用户看的简短说明","analysis":{"subject":"","scene":"","composition":"","lighting":"","style":""},"layout":"single_image|multi_image","count":1,"aspectRatio":"auto|1:1|2:3|3:2|4:3|5:4|16:9|3:4|4:5|9:16|21:9","size":"1K|2K|4K","negativePrompt":"","referencePolicy":"no_reference|use_reference|analyze_only","regions":[],"keywords":[{"title":"方案标题","prompt":"可直接送入生图模型的提示词"}]}\n\n受控改写规则：\n- preserve：保留用户原始结构和表达，不做自由美化，不改变区域、比例、顺序、数量。\n- conservative：只做轻度整理和摄影质量补充，保留主体、颜色、数量、材质、包装、视角、背景、否定约束；不要添加用户未要求的复杂场景、人物、道具、品牌、夸张特效；白底/纯色背景不能改成环境图。\n- enhance：允许适度增强构图、光影、质感、风格，但不得改变用户指定的主体、数量、颜色、视角、背景和否定约束。\n\nregions 字段说明：\n- 当用户描述了“一张图的多个区域/板块/分区”时（如上方区域、中间区域、下方区域，或区域A/B/C），必须将每个区域的内容原样映射到 regions 数组。\n- 每个 region 格式：{"name":"区域名称","description":"该区域的具体设计内容，必须忠实还原用户原文"}\n- regions 里的内容是最终生图提示词的依据，必须严格按用户描述来写，不得自行简化、合并或重新概括。\n- 如果用户没有描述分区结构，regions 留空数组 []。\n\nlayout 字段说明：\n- single_image：用户意图是生成单张图片（可能包含多个区域/板块）。当用户说"1张图3个板块"、"一张图分上中下"、"一套A+页面"、"一个海报分N个区域"时，layout 必须是 single_image。\n- multi_image：用户明确要生成多张独立的图片（如"生成3张不同的海报"、"来5张风景图"）。\n- 判定核心：用户说的是"一张图的多个部分"还是"多张独立的图"。前者 single_image + count=1，后者 multi_image + count=N。\n\n规则：\n1. text_to_image：只根据用户文字整理提示词，referencePolicy 必须是 no_reference。\n2. image_to_image：这是改图/修图任务，referencePolicy 必须是 use_reference；提示词里要写清楚保留什么、修改什么。\n3. analyze_to_text2img：先分析参考图风格，再生成“类似风格的新图”，referencePolicy 必须是 analyze_only；不要把它写成修改原图。\n4. keywords 必须是数组，长度尽量等于 count，每个 prompt 都要完整可执行。\n5. 如果用户只要 1 张，也必须返回 1 条 keywords。\n6. analysis 只在 analyze_to_text2img 时填写，其它模式可留空字符串。\n7. 文生图或分析后文生图时，不要要求把参考图继续传给生图模型。\n8. prompt 里不要保留“生成3张、来几张、图片、帮我”等控制词。\n9. 如果用户文字里明确写了比例或尺寸（如“4:3”、“4比3”、“1024x1024”），优先用用户文字里的。\n10. 如果用户文字里没写比例或尺寸，就用用户已选的：比例${selectedAspectRatio}、尺寸${selectedSize}。\n11. 不要擅自修改用户已选的比例和尺寸，除非用户文字里明确指定了不同的值。\n12. 【最重要】用户提供的设计规范、模板、分区描述是最高优先级指令，必须逐条忠实还原，不得用通用描述替代。如果用户说了“上方区域做什么、中间区域做什么、下方区域做什么”，你的 keywords[0].prompt 里必须包含这些区域的具体内容。\n13. 当用户意图是“一张图包含多个区域/板块”时，count 必须为 1，不要把区域数当成图片数。keywords 里只需 1 条 prompt，把所有区域内容合并进同一条 prompt。\n\n用户需求：${userMessage.content || '生成图片'}`,
        images: userMessage.images || []
    }, true);

    const contextMessages = await buildApiContextMessages('你是专业的图像分析、视觉风格提炼与生图提示词规划助手。参考对话历史理解用户意图，特别是用户之前定义的风格、关键词等。', chat, true);
    contextMessages.push({ role: 'user', content });

    const response = await fetch(`${config.apiBase.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.token}`
        },
        body: JSON.stringify({
            model: config.modelId,
            stream: false,
            messages: contextMessages
        })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || errorData.message || `图像分析失败: HTTP ${response.status}`);
    }

    const data = await response.json();
    const text = (parseTextFromResponse(data) || '').trim();
    const parsed = extractJsonObject(text);
    if (parsed && parsed.mode) {
        const planMode = ['text_to_image', 'image_to_image', 'analyze_to_text2img'].includes(parsed.mode) ? parsed.mode : (intent?.mode || 'text_to_image');
        const layout = ['single_image', 'multi_image'].includes(parsed.layout) ? parsed.layout : null;
        const count = clampChatImageCount(parsed.count || intent?.count || requestCount, requestCount);
        const aspectRatio = sanitizeChatAspectRatio(intent?.aspectRatio, sanitizeChatAspectRatio(parsed.aspectRatio, 'auto'));
        const size = sanitizeChatImageSize(intent?.size, sanitizeChatImageSize(parsed.size, '1K'));
        const referencePolicy = sanitizeChatReferencePolicy(parsed.referencePolicy, defaultReferencePolicy);
        const negativePrompt = normalizeChatImagePrompt(parsed.negativePrompt, intent?.negativePrompt || '');
        const keywords = normalizeChatKeywordEntries(parsed.keywords, parsed.prompt || fallbackPrompt, count);
        const normalizedPlan = {
            mode: planMode,
            layout: layout || (Array.isArray(parsed.regions) && parsed.regions.length > 0 ? 'single_image' : null),
            responseText: String(parsed.responseText || '').trim(),
            analysis: parsed.analysis && typeof parsed.analysis === 'object' ? parsed.analysis : {},
            count,
            aspectRatio,
            size,
            negativePrompt,
            referencePolicy,
            keywords
        };
        return {
            analysisText: planMode === 'analyze_to_text2img' ? buildChatAnalysisSummaryText(normalizedPlan, fallbackPrompt) : '',
            prompt: keywords[0]?.prompt || fallbackPrompt,
            prompts: keywords.map(item => item.prompt),
            keywords,
            count,
            aspectRatio,
            size,
            negativePrompt,
            referencePolicy,
            layout: normalizedPlan.layout,
            responseText: normalizedPlan.responseText
        };
    }

    const marker = text.match(/生图提示词[：:]([\s\S]*)$/);
    const prompt = (marker ? marker[1] : text).trim() || fallbackPrompt;
    const fallbackKeywords = normalizeChatKeywordEntries(extractChatImagePrompts(text, fallbackPrompt), fallbackPrompt, requestCount);
    return {
        analysisText: intent?.mode === 'analyze_to_text2img'
            ? (text || `分析结果：已根据参考图提炼画面风格。\n\n生图提示词：\n${fallbackKeywords.map((item, index) => `${index + 1}. ${item.prompt}`).join('\n')}`)
            : '',
        prompt,
        prompts: fallbackKeywords.map(item => item.prompt),
        keywords: fallbackKeywords,
        count: clampChatImageCount(intent?.count || fallbackKeywords.length || requestCount, requestCount),
        aspectRatio: sanitizeChatAspectRatio(intent?.aspectRatio, 'auto'),
        size: sanitizeChatImageSize(intent?.size, '1K'),
        negativePrompt: normalizeChatImagePrompt(intent?.negativePrompt, ''),
        referencePolicy: sanitizeChatReferencePolicy(intent?.referencePolicy, defaultReferencePolicy),
        responseText: ''
    };
}

function extractChatImagePrompts(text, fallbackPrompt) {
    const raw = String(text || '').trim();
    const prompts = [];
    const promptMatches = raw.matchAll(/Prompt\s*[:：]\s*([^\n]+(?:\n(?!\s*(?:\d+[\.、)]|Prompt\s*[:：]|生图提示词\s*[:：])).*)?)/gi);
    for (const match of promptMatches) {
        const value = String(match[1] || '').trim();
        if (value && value.length > 12) prompts.push(value.replace(/\n+/g, ' '));
    }
    if (prompts.length > 0) return prompts.slice(0, 8);

    const marker = raw.match(/生图提示词[：:]([\s\S]*)$/);
    if (marker) {
        const lines = marker[1].split(/\n+/).map(line => line.replace(/^\s*\d+[\.、)：:)\]]\s*/, '').trim()).filter(line => line.length > 12);
        if (lines.length > 0) return lines.slice(0, 8);
    }

    return [String(fallbackPrompt || raw || '根据描述生成图片').trim()].filter(Boolean);
}

function resolveChatImagePromptList(intent, plan, userMessage) {
    const fallbackPrompt = buildChatImagePrompt(intent, userMessage);
    const planKeywords = normalizeChatKeywordEntries(plan?.keywords, fallbackPrompt, plan?.count || intent?.count || 1);
    const planPrompts = planKeywords.length > 0
        ? planKeywords.map(item => item.prompt)
        : (Array.isArray(plan?.prompts) ? plan.prompts.map(p => String(p || '').trim()).filter(Boolean) : []);
    const extractedPrompts = planPrompts.length > 0 ? planPrompts : extractChatImagePrompts(plan?.prompt || plan?.analysisText || '', fallbackPrompt);
    const text = String(userMessage?.content || '').trim();

    // 【优先检测】单张多区域意图：plan.layout 为主信号，正则兜底
    const isSingleMultiRegion = plan?.layout === 'single_image'
        || (Array.isArray(plan?.regions) && plan.regions.length > 0)
        || (!plan?.layout && [
            /(?:一|1)\s*(?:张|个|幅|套)\s*(?:图|图片|海报|页面|设计)\s*.{0,10}?(?:分|包含|含有|包括|有)\s*(?:\d+|[一二三四五六七八九十])\s*(?:个|块)?\s*(?:区域|板块|分区|部分|块|层)/,
            /(?:一|1)\s*(?:张|个|幅|套)\s*(?:图|图片|海报|页面|设计)\s*.{0,10}?(?:上中下|左右|上下)/,
            /(?:单张|一张图|一幅图)\s*.{0,8}?(?:多个|几种|不同)\s*(?:区域|板块|分区|部分)/,
            /(?:分|划分为?|拆分为?)\s*(?:\d+|[一二三四五六七八九十])\s*(?:个|块)?\s*(?:区域|板块|分区|部分|块).{0,10}?(?:一|1)\s*(?:张|个|幅)\s*(?:图|图片)/
        ].some(p => p.test(text)));
    const isMultiImage = plan?.layout === 'multi_image';

    if (isSingleMultiRegion) {
        // 强制 count=1，把所有区域内容合并到同一条 prompt
        const basePrompt = extractedPrompts[0] || normalizeChatImagePrompt(text, fallbackPrompt) || fallbackPrompt;
        // 如果 plan 返回了 regions，把区域描述拼接到 prompt 里
        if (Array.isArray(plan?.regions) && plan.regions.length > 0) {
            const regionDesc = plan.regions.map(r => `${r.name || '区域'}：${r.description || ''}`).join('\n');
            const mergedPrompt = regionDesc ? `${basePrompt}\n\n${regionDesc}` : basePrompt;
            return [mergedPrompt];
        }
        return [basePrompt];
    }

    const cnNumMap = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    const digitMatch = text.match(/(?:生成|做|出|来|给我|要)?\s*(\d+)\s*(?:张|个|幅|份|套)/);
    const cnMatch = text.match(/(?:生成|做|出|来|给我|要)?\s*([一二两三四五六七八九十])\s*(?:张|个|幅|份|套)/);
    const rawCount = digitMatch ? parseInt(digitMatch[1], 10) : (cnMatch ? (cnNumMap[cnMatch[1]] || 1) : null);
    const explicitCount = rawCount ? clampChatImageCount(rawCount, 1) : null;
    const pluralHint = /(几张|多张|多来几张|三张|四张|五张|六张|七张|八张|九张|十张|两张|2张|3张|4张|5张)/.test(text);
    const targetCount = clampChatImageCount(plan?.count || intent?.count || extractedPrompts.length || 1, explicitCount || 1);

    // 纯文生图：如果AI规划返回了多个不同的prompts，使用它们；否则用同一提示词重复生成
    if (intent?.mode === 'text_to_image') {
        const count = explicitCount || targetCount || (pluralHint ? 2 : 1);
        // 如果AI规划返回了多个不同的prompts，优先使用
        if (extractedPrompts.length >= count && extractedPrompts.some((p, i) => i > 0 && p !== extractedPrompts[0])) {
            return extractedPrompts.slice(0, count);
        }
        // 否则用同一提示词重复生成
        const basePrompt = extractedPrompts[0] || normalizeChatImagePrompt(userMessage?.content, fallbackPrompt) || fallbackPrompt;
        return Array.from({ length: count }, (_, i) => extractedPrompts[i] || basePrompt);
    }

    if (explicitCount) {
        if (extractedPrompts.length >= explicitCount) return extractedPrompts.slice(0, explicitCount);
        if (extractedPrompts.length > 0) {
            const arr = extractedPrompts.slice();
            while (arr.length < explicitCount) arr.push(arr[arr.length - 1] || fallbackPrompt);
            return arr;
        }
        return Array.from({ length: explicitCount }, () => fallbackPrompt);
    }

    if (pluralHint) {
        if (extractedPrompts.length > 1) return extractedPrompts.slice(0, 2);
        return [extractedPrompts[0] || fallbackPrompt, extractedPrompts[0] || fallbackPrompt];
    }

    if (targetCount > 1 && extractedPrompts.length > 0) {
        const arr = extractedPrompts.slice(0, targetCount);
        while (arr.length < targetCount) arr.push(arr[arr.length - 1] || fallbackPrompt);
        return arr;
    }

    return [extractedPrompts[0] || fallbackPrompt];
}

async function requestChatImageResponse(chat, userMessage, forcedIntent = null, preResolvedPrompts = null, prePlan = null) {
    const pendingIdx = chat.messages.findIndex(m => m.pending && m.role === 'ai');
    if (pendingIdx >= 0) {
        chat.messages.splice(pendingIdx, 1);
    }
    chat.messages.push({ role: 'ai', content: '正在思考...', pending: true, timestamp: Date.now() });
    renderChatMessages();
    void flushChatPersistence();

    setChatSendingState(true);
    try {
        const intent = normalizeChatImageIntent(forcedIntent || await resolveChatImageIntent(chat, userMessage), userMessage);

        if (!intent) {
            const p = chat.messages[chat.messages.length - 1];
            if (p?.pending) chat.messages.pop();
            chat.messages.push({
                role: 'ai',
                content: '我先按普通对话理解这条消息。',
                timestamp: Date.now()
            });
            renderChatMessages();
            void flushChatPersistence();
            return;
        }

        const plan = prePlan || await planChatImagePromptWithChatModel(chat, userMessage, intent);
        const plannedIntent = normalizeChatImageIntent({
            ...intent,
            prompt: plan?.prompt || intent.prompt,
            count: plan?.count || intent.count,
            aspectRatio: plan?.aspectRatio || intent.aspectRatio,
            size: plan?.size || intent.size,
            negativePrompt: plan?.negativePrompt || intent.negativePrompt,
            referencePolicy: plan?.referencePolicy || intent.referencePolicy,
            keywords: plan?.keywords || intent.keywords
        }, userMessage) || intent;

        // 统一插入"正在生图..."占位（分析结果已在 sendChatMessage 中展示，此处不重复）
        {
            const p = chat.messages[chat.messages.length - 1];
            if (p?.pending) chat.messages.pop();
            chat.messages.push({ role: 'ai', content: '正在生图...', pending: true, timestamp: Date.now() });
            renderChatMessages();
            void flushChatPersistence();
        }

        const prompts = preResolvedPrompts || resolveChatImagePromptList(plannedIntent, plan, userMessage);
        const batchId = `batch-${Date.now()}`;
        
        // 构建图片元信息（模型/比例/尺寸）
        const model = getChatImageModelId();
        const aspectRatio = plannedIntent?.aspectRatio || 'auto';
        const imageSize = plannedIntent?.size || '1K';
        const imageMetaText = `模型：${model} · 比例：${aspectRatio} · 尺寸：${imageSize}`;
        
        // 1. 先插入N个占位格子
        const latest = chat.messages[chat.messages.length - 1];
        if (latest?.pending) chat.messages.pop();
        
        const placeholderImages = prompts.map((prompt, index) => ({
            data: '',
            previewData: '',
            taskId: `${batchId}-${index}`,
            source: 'generating',
            prompt: prompt || '',
            label: `第 ${index + 1} 张`,
            placeholder: true,
            index: index,
            aspectRatio: aspectRatio === 'auto' ? '1:1' : aspectRatio
        }));
        
        chat.messages.push({
            role: 'ai',
            content: '',
            images: placeholderImages,
            imageLayout: 'multi',
            batchId: batchId,
            imageMeta: imageMetaText,
            timestamp: Date.now()
        });
        renderChatMessages();
        void flushChatPersistence();
        
        // 2. 并行发起N个请求，每个绑定目标位置
        const generateTasks = prompts.map((prompt, index) => {
            return submitChatImageTask(chat, userMessage, { ...plannedIntent, prompt })
                .then(result => ({ index, batchId, prompt, result, success: result?.status === 'success' && result?.imageUrl }))
                .catch(err => ({ index, batchId, prompt, result: null, success: false, error: err }));
        });
        
        // 3. 每个完成时替换对应位置
        generateTasks.forEach(task => {
            task.then(({ index, batchId, prompt, result, success, error }) => {
                // 找到对应的消息和占位图
                const msgIndex = chat.messages.findIndex(m => m.batchId === batchId);
                if (msgIndex < 0) return;
                
                const msg = chat.messages[msgIndex];
                if (!msg.images || !Array.isArray(msg.images)) return;
                
                // 找到对应索引的占位图并替换
                const imgIndex = msg.images.findIndex(img => img.index === index && img.placeholder);
                if (imgIndex < 0) return;
                
                const finalAspectRatio = aspectRatio === 'auto' ? '1:1' : aspectRatio;
                if (success) {
                    msg.images[imgIndex] = {
                        data: result.imageUrl,
                        previewData: result.imageUrl,
                        taskId: result.taskId || '',
                        source: 'generated',
                        prompt: prompt || '',
                        label: `第 ${index + 1} 张`,
                        placeholder: false,
                        index: index,
                        aspectRatio: finalAspectRatio
                    };
                    // 后台缓存图片到IndexedDB（缩略图+原图）
                    void cacheChatImageToDB(result.imageUrl);
                } else {
                    // 生成失败，显示错误占位
                    const failureText = formatChatImageErrorReason(error?.message || result?.reason || '生成失败');
                    msg.images[imgIndex] = {
                        data: '',
                        previewData: '',
                        taskId: '',
                        source: 'failed',
                        prompt: prompt || '',
                        label: `第 ${index + 1} 张 (失败)`,
                        placeholder: false,
                        index: index,
                        aspectRatio: finalAspectRatio,
                        error: failureText
                    };
                }
                
                renderChatMessages();
                void flushChatPersistence();
            });
        });
        
        // 等待所有任务完成
        await Promise.all(generateTasks);
    } catch (err) {
        const p = chat.messages[chat.messages.length - 1];
        if (p?.pending) chat.messages.pop();
        chat.messages.push({
            role: 'ai',
            content: `生图失败：${formatChatImageErrorReason(err || '请求失败')}`,
            error: true,
            imageTask: {
                prompt: normalizeChatImagePrompt(userMessage.content, '根据描述生成图片'),
                images: Array.isArray(userMessage.images) ? userMessage.images.map(img => ({ ...img })) : [],
                intent: normalizeChatImageIntent(forcedIntent || detectChatImageIntent(userMessage.content, userMessage.images), userMessage)
            },
            timestamp: Date.now()
        });
        renderChatMessages();
        void flushChatPersistence();
        showToast(formatChatImageErrorReason(err || '生图失败'));
    } finally {
        setChatSendingState(false);
        void flushChatPersistence();
        renderChatMessages();
    }
}

// ========== 新流程：执行生图 ==========
// 接收已构思好的 plan，直接执行生图，不重新规划
async function executeImageGeneration(chat, userMessage, plan) {
    try {
        const mode = plan.mode || 'text_to_image';
        const prompts = normalizeChatKeywordEntries(
            Array.isArray(plan.keywords) ? plan.keywords : [],
            plan.prompt || userMessage.content || '根据描述生成图片',
            plan.count || (Array.isArray(plan.keywords) ? plan.keywords.length : 1) || 1
        ).map(item => item.prompt);
        const aspectRatio = plan.aspectRatio || 'auto';
        const imageSize = plan.size || '1K';
        const referencePolicy = plan.referencePolicy || (mode === 'image_to_image' ? 'use_reference' : 'no_reference');

        const intent = {
            mode,
            prompt: prompts[0] || '',
            count: prompts.length,
            aspectRatio,
            size: imageSize,
            negativePrompt: plan.negativePrompt || '',
            referencePolicy,
            hasImages: Array.isArray(userMessage.images) && userMessage.images.length > 0,
            source: 'deep_plan'
        };

        // 显示"正在生图..."
        {
            const p = chat.messages[chat.messages.length - 1];
            if (p?.pending) chat.messages.pop();
            chat.messages.push({ role: 'ai', content: '正在生图...', pending: true, timestamp: Date.now() });
            renderChatMessages();
            void flushChatPersistence();
        }

        const batchId = `batch-${Date.now()}`;
        const model = getChatImageModelId();
        const imageMetaText = `模型：${model} · 比例：${aspectRatio} · 尺寸：${imageSize}`;

        // 1. 先插入N个占位格子
        const latest = chat.messages[chat.messages.length - 1];
        if (latest?.pending) chat.messages.pop();

        const placeholderImages = prompts.map((prompt, index) => ({
            data: '',
            previewData: '',
            taskId: `${batchId}-${index}`,
            source: 'generating',
            prompt: prompt || '',
            label: `第 ${index + 1} 张`,
            placeholder: true,
            index: index,
            aspectRatio: aspectRatio === 'auto' ? '1:1' : aspectRatio
        }));

        chat.messages.push({
            role: 'ai',
            content: '',
            images: placeholderImages,
            imageLayout: 'multi',
            batchId: batchId,
            imageMeta: imageMetaText,
            timestamp: Date.now()
        });
        renderChatMessages();
        void flushChatPersistence();

        // 2. 并行发起N个请求
        const generateTasks = prompts.map((prompt, index) => {
            return submitChatImageTask(chat, userMessage, { ...intent, prompt })
                .then(result => ({ index, batchId, prompt, result, success: result?.status === 'success' && result?.imageUrl }))
                .catch(err => ({ index, batchId, prompt, result: null, success: false, error: err }));
        });

        // 3. 每个完成时替换对应位置
        generateTasks.forEach(task => {
            task.then(({ index, batchId, prompt, result, success, error }) => {
                const msgIndex = chat.messages.findIndex(m => m.batchId === batchId);
                if (msgIndex < 0) return;

                const msg = chat.messages[msgIndex];
                if (!msg.images || !Array.isArray(msg.images)) return;

                const imgIndex = msg.images.findIndex(img => img.index === index && img.placeholder);
                if (imgIndex < 0) return;

                const finalAspectRatio = aspectRatio === 'auto' ? '1:1' : aspectRatio;
                if (success) {
                    msg.images[imgIndex] = {
                        data: result.imageUrl,
                        previewData: result.imageUrl,
                        taskId: result.taskId || '',
                        source: 'generated',
                        prompt: prompt || '',
                        label: `第 ${index + 1} 张`,
                        placeholder: false,
                        index: index,
                        aspectRatio: finalAspectRatio
                    };
                    void cacheChatImageToDB(result.imageUrl);
                } else {
                    const failureText = formatChatImageErrorReason(error?.message || result?.reason || '生成失败');
                    msg.images[imgIndex] = {
                        data: '',
                        previewData: '',
                        taskId: '',
                        source: 'failed',
                        prompt: prompt || '',
                        label: `第 ${index + 1} 张 (失败)`,
                        placeholder: false,
                        index: index,
                        aspectRatio: finalAspectRatio,
                        error: failureText
                    };
                }

                renderChatMessages();
                void flushChatPersistence();
            });
        });

        await Promise.all(generateTasks);
    } catch (err) {
        const p = chat.messages[chat.messages.length - 1];
        if (p?.pending) chat.messages.pop();
        chat.messages.push({
            role: 'ai',
            content: `生图失败：${formatChatImageErrorReason(err || '请求失败')}`,
            error: true,
            timestamp: Date.now()
        });
        renderChatMessages();
        void flushChatPersistence();
        showToast(formatChatImageErrorReason(err || '生图失败'));
    }
}

async function retryChatImageMessage(index) {
    if (chatIsSending) {
        showToast('请等待当前任务完成');
        return;
    }
    const chat = chatConversations.find(c => c.id === currentChatId);
    const msg = chat?.messages?.[index];
    if (!chat || !msg || !msg.error || !msg.imageTask) return;

    chat.messages.splice(index, 1);
    renderChatMessages();
    void flushChatPersistence();

    const userMessage = {
        content: msg.imageTask.prompt || '',
        images: Array.isArray(msg.imageTask.images) ? msg.imageTask.images.map(img => ({ ...img })) : []
    };

    try {
        const retryIntent = normalizeChatImageIntent(
            msg.imageTask.intent || detectChatImageIntent(userMessage.content, userMessage.images),
            userMessage
        ) || {};
        const retryCount = clampChatImageCount(
            retryIntent.count || (Array.isArray(retryIntent.keywords) ? retryIntent.keywords.length : 1) || 1,
            1
        );
        const retryKeywords = normalizeChatKeywordEntries(
            retryIntent.keywords,
            retryIntent.prompt || userMessage.content || '根据描述生成图片',
            retryCount
        );
        const retryMode = retryIntent.mode || (userMessage.images.length > 0 ? 'image_to_image' : 'text_to_image');
        const retryPlan = {
            mode: retryMode,
            keywords: retryKeywords.map(item => item.prompt),
            count: retryKeywords.length,
            aspectRatio: sanitizeChatAspectRatio(
                retryIntent.aspectRatio,
                document.getElementById('chatAspectRatioSelect')?.value || 'auto'
            ),
            size: sanitizeChatImageSize(
                retryIntent.size,
                document.getElementById('chatImageSizeSelect')?.value || '1K'
            ),
            negativePrompt: normalizeChatImagePrompt(retryIntent.negativePrompt, ''),
            referencePolicy: sanitizeChatReferencePolicy(
                retryIntent.referencePolicy,
                retryMode === 'image_to_image' ? 'use_reference' : 'no_reference'
            )
        };
        setChatSendingState(true);
        try {
            await executeImageGeneration(chat, userMessage, retryPlan);
        } finally {
            setChatSendingState(false);
        }
    } catch (err) {
        debugWarn('retryChatImageMessage:', err);
    }
}

async function loadChatDataOnInit() {
    await loadChatsFromDB();
    if (chatConversations.length === 0) {
        createNewChat();
    } else if (!currentChatId) {
        currentChatId = chatConversations[0].id;
    }
    renderChatList();
    syncChatModelSelect();
    renderChatMessages();
    // 页面加载后清理孤儿缓存（不阻塞渲染）
    void cleanupOrphanImageCache();
}

function initChatMode() {
    if (chatModeInitialized) return;
    if (!document.getElementById('chatMessages')) return;
    chatModeInitialized = true;

    setupChatListDelegation();
    setupChatMessagesDelegation();
    setupChatPreviewDelegation();
    
    // 对话模式手机端折叠事件绑定
    const chatInputBox = document.getElementById('chatInputBox');
    const chatCollapseToggle = document.getElementById('chatCollapseToggle');
    if (chatCollapseToggle) {
        chatCollapseToggle.addEventListener('click', toggleChatCollapse);
    }
    if (chatInputBox) {
        chatInputBox.addEventListener('click', (e) => {
            if (chatInputBox.classList.contains('chat-collapsed')) {
                e.preventDefault();
                e.stopPropagation();
                toggleChatCollapse(e);
            }
        });
    }

    // 新对话按钮
    const newBtn = document.getElementById('chatNewBtn');
    if (newBtn) newBtn.addEventListener('click', createNewChat);
    
    // 清空历史按钮
    const clearBtn = document.getElementById('chatClearBtn');
    if (clearBtn) clearBtn.addEventListener('click', clearAllChats);
    
    // 发送 / 停止按钮
    const sendBtn = document.getElementById('chatSendBtn');
    if (sendBtn) {
        sendBtn.addEventListener('click', () => {
            if (chatIsSending) stopChatGeneration();
            else sendChatMessage();
        });
    }

    // 移动端侧边栏切换
    const chatMenuBtn = document.getElementById('chatMenuBtn');
    const chatSidebar = document.getElementById('chatSidebar');
    const chatSidebarOverlay = document.getElementById('chatSidebarOverlay');
    function toggleChatSidebar(open) {
        const isOpen = chatSidebar.classList.contains('chat-sidebar-open');
        const shouldOpen = open !== undefined ? open : !isOpen;
        chatSidebar.classList.toggle('chat-sidebar-open', shouldOpen);
        chatSidebarOverlay.classList.toggle('active', shouldOpen);
        document.body.classList.toggle('chat-sidebar-opened', shouldOpen);
    }
    if (chatMenuBtn) chatMenuBtn.addEventListener('click', () => toggleChatSidebar());
    if (chatSidebarOverlay) chatSidebarOverlay.addEventListener('click', () => toggleChatSidebar(false));
    // 点击对话历史项后自动关闭侧边栏
    const chatSidebarList = document.getElementById('chatSidebarList');
    if (chatSidebarList) chatSidebarList.addEventListener('click', (e) => {
        if (e.target.closest('.chat-history-item')) toggleChatSidebar(false);
    });

    // 移动端：点击下拉遮罩关闭所有下拉菜单
    const chatSelectOverlay = document.getElementById('chatSelectOverlay');
    if (chatSelectOverlay) chatSelectOverlay.addEventListener('click', () => {
        document.querySelectorAll('.custom-select-menu.show, .model-dropdown-menu.show').forEach(m => m.classList.remove('show'));
        chatSelectOverlay.classList.remove('active');
    });

    // 输入框回车发送 + 粘贴图片
    const input = document.getElementById('chatInput');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
        // 自动调整高度（上限8行，约192px）
        input.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 192) + 'px';
        });
        // 粘贴图片（支持多张）
        input.addEventListener('paste', (e) => {
            const items = (e.clipboardData || e.originalEvent.clipboardData).items;
            let pasted = false;
            for (const item of items) {
                if (item.kind === 'file' && item.type.startsWith('image/')) {
                    handleChatImageUpload(item.getAsFile());
                    pasted = true;
                }
            }
            if (pasted) e.preventDefault();
        });
    }
    
    // 上传图片按钮
    const uploadBtn = document.getElementById('chatUploadBtn');
    if (uploadBtn) {
        uploadBtn.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.multiple = true;
            fileInput.onchange = (e) => {
                if (e.target.files && e.target.files.length) {
                    Array.from(e.target.files).forEach((file) => handleChatImageUpload(file));
                }
            };
            fileInput.click();
        });
    }

    const chatModelSelect = document.getElementById('chatModelSelect');
    if (chatModelSelect && !chatModelSelect._lorisModelBound) {
        chatModelSelect._lorisModelBound = true;
        chatModelSelect.addEventListener('change', () => {
            const c = chatConversations.find(x => x.id === currentChatId);
            if (c) c.model = chatModelSelect.value;
            void flushChatPersistence();
        });
    }

    if (!window._lorisChatPersistenceFlushRegistered) {
        window._lorisChatPersistenceFlushRegistered = true;
        window.addEventListener('pagehide', () => { flushChatPersistenceSync(); });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushChatPersistenceSync();
        });
    }
    
    loadChatDataOnInit().catch((err) => debugWarn('对话数据加载失败:', err));
}

function createNewChat() {
    const chatId = Date.now().toString();
    const model = document.getElementById('chatModelSelect')?.value;
    const newChat = {
        id: chatId,
        title: '新对话',
        messages: [],
        model: model || undefined,
        createdAt: Date.now()
    };
    chatConversations.unshift(newChat);
    currentChatId = chatId;
    renderChatList();
    renderChatMessages();
    void flushChatPersistence();
}

function renderChatList() {
    const listEl = document.getElementById('chatSidebarList');
    if (!listEl) return;
    
    listEl.innerHTML = chatConversations.map(chat => `
        <div class="chat-history-item ${chat.id === currentChatId ? 'active' : ''}" data-id="${chat.id}">
            <span class="chat-history-title" data-id="${chat.id}">${escapeHTML(chat.title)}</span>
            <button class="chat-history-del" data-id="${chat.id}" title="删除"><i class="fas fa-times"></i></button>
        </div>
    `).join('');
}

// 事件委托：只绑定一次，不随DOM更新丢失
function setupChatListDelegation() {
    const listEl = document.getElementById('chatSidebarList');
    if (!listEl || listEl._delegated) return;
    listEl._delegated = true;

    // 单击切换 vs 双击重命名：用延迟切换避免 DOM 重绘打断 dblclick 识别
    let clickTimer = null;
    
    // 点击切换对话
    listEl.addEventListener('click', (e) => {
        const delBtn = e.target.closest('.chat-history-del');
        if (delBtn) {
            e.stopPropagation();
            const chatId = delBtn.dataset.id;
            const chat = chatConversations.find(c => c.id === chatId);
            const title = chat ? chat.title : '该对话';
            if (confirm(`确定要删除"${title}"吗？\n\n此操作不可恢复。`)) {
                deleteChat(chatId);
            }
            return;
        }
        
        // 如果正在重命名，不切换
        if (e.target.tagName === 'INPUT') return;
        
        const item = e.target.closest('.chat-history-item');
        if (!item || !item.dataset.id) return;

        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
            switchChat(item.dataset.id);
            clickTimer = null;
        }, 200);
    });
    
    // 双击重命名（事件委托）
    listEl.addEventListener('dblclick', (e) => {
        if (clickTimer) {
            clearTimeout(clickTimer);
            clickTimer = null;
        }
        // 双击删除按钮不触发重命名
        if (e.target.closest('.chat-history-del')) return;

        // 支持双击整条历史项进入重命名（不要求必须点在标题文字上）
        const item = e.target.closest('.chat-history-item');
        if (!item || !item.dataset.id) return;
        const titleEl = item.querySelector('.chat-history-title');
        e.stopPropagation();
        startRenameChat(item.dataset.id, titleEl || item);
    });
}

function setupChatMessagesDelegation() {
    const messagesEl = document.getElementById('chatMessages');
    if (!messagesEl || messagesEl._chatDelegated) return;
    messagesEl._chatDelegated = true;

    // 图片加载失败时，从IndexedDB缓存中恢复
    messagesEl.addEventListener('error', async (e) => {
        const img = e.target;
        if (!img || img.tagName !== 'IMG' || !img.classList.contains('chat-bubble-img')) return;
        if (img._cacheAttempted) return; // 避免无限循环
        img._cacheAttempted = true;
        // 优先用 data-cache-key（用户上传图片有持久化cacheKey），其次用 src（AI回传URL）
        const cacheKey = img.dataset.cacheKey;
        const lookupKey = cacheKey || img.src;
        const cached = await getCachedChatImageFromDB(lookupKey);
        if (cached) {
            // 优先用原图，其次缩略图
            img.src = cached.original || cached.thumbnail || '';
            if (!img.src) {
                img.style.opacity = '0.4';
                img.alt = '图片已过期';
            }
        } else {
            // cacheKey查不到时，再用src兜底查一次（兼容AI回传图片的旧缓存）
            if (cacheKey && img.src && img.src !== cacheKey) {
                const fallback = await getCachedChatImageFromDB(img.src);
                if (fallback) {
                    img.src = fallback.original || fallback.thumbnail || '';
                    if (!img.src) { img.style.opacity = '0.4'; img.alt = '图片已过期'; }
                    return;
                }
            }
            img.style.opacity = '0.4';
            img.alt = '图片已过期';
            handleImageLoadError(img);
        }
    }, true);

    messagesEl.addEventListener('click', (e) => {
        const bubbleImg = e.target.closest('.chat-bubble-img');
        if (bubbleImg) {
            const msgEl = bubbleImg.closest('.chat-msg');
            const msgIndex = msgEl && msgEl.dataset.msgIndex !== undefined ? parseInt(msgEl.dataset.msgIndex, 10) : -1;
            const imgIndex = parseInt(bubbleImg.dataset.imgIndex || '0', 10) || 0;
            const chat = chatConversations.find(c => c.id === currentChatId);
            const msg = chat?.messages?.[msgIndex];
            const gallery = Array.isArray(msg?.images)
                ? msg.images.map((img, index) => ({
                    src: index === imgIndex ? (bubbleImg.getAttribute('src') || img.data || img.url || '') : (img.data || img.url || ''),
                    prompt: img.prompt || msg?.content || '',
                    label: img.label || `第 ${index + 1} 张`,
                    source: img.source || 'generated'
                })).filter(item => item.src && item.source !== 'failed')
                : [];
            if (gallery.length > 0) {
                openPreviewGallery(gallery, imgIndex, 'banana_chat');
            } else {
                const src = bubbleImg.getAttribute('src');
                if (src) previewUpload(src, bubbleImg.dataset.prompt || '图片');
            }
            return;
        }

        // 匹配操作按钮和折叠按钮
        const actionBtn = e.target.closest('.chat-msg-action-btn') || e.target.closest('.chat-collapse-btn');
        if (!actionBtn) return;

        // 折叠按钮不需要 msgIndex
        if (actionBtn.dataset.action === 'collapse') {
            const bubble = actionBtn.closest('.chat-msg-bubble');
            if (bubble) {
                bubble.classList.toggle('collapsed');
                const icon = actionBtn.querySelector('i');
                if (icon) {
                    icon.className = bubble.classList.contains('collapsed') ? 'fas fa-expand' : 'fas fa-compress';
                }
            }
            return;
        }

        const msgEl = actionBtn.closest('.chat-msg');
        if (!msgEl || msgEl.dataset.msgIndex === undefined) return;

        const msgIndex = parseInt(msgEl.dataset.msgIndex, 10);
        if (Number.isNaN(msgIndex)) return;

        const action = actionBtn.dataset.action;
        if (action === 'delete') deleteChatMessage(msgIndex);
        else if (action === 'regenerate') regenerateMessage(msgIndex);
        else if (action === 'copy') copyMessage(msgIndex);
        else if (action === 'reuse') reuseChatMessage(msgIndex);
        else if (action === 'retry-image') retryChatImageMessage(msgIndex);
    });
}

function setupChatPreviewDelegation() {
    const previewEl = document.getElementById('chatImagesPreview');
    if (!previewEl || previewEl._chatDelegated) return;
    previewEl._chatDelegated = true;

    previewEl.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.chat-image-remove');
        if (removeBtn) {
            e.stopPropagation();
            const thumb = removeBtn.closest('.chat-image-thumb');
            if (thumb && thumb.dataset.index !== undefined) {
                removeChatImage(parseInt(thumb.dataset.index, 10));
            }
            return;
        }

        const img = e.target.closest('.chat-image-thumb img');
        if (img && img.src) {
            const thumb = img.closest('.chat-image-thumb');
            const idx = thumb && thumb.dataset.index !== undefined ? parseInt(thumb.dataset.index, 10) + 1 : 1;
            previewUpload(img.src, `参考图${idx}`);
        }
    });
}

function startRenameChat(chatId, titleEl) {
    const chat = chatConversations.find(c => c.id === chatId);
    if (!chat) return;
    
    const input = document.createElement('input');
    input.type = 'text';
    input.value = chat.title;
    input.className = 'chat-rename-input';
    input.style.cssText = 'flex:1;padding:4px 8px;border:1px solid var(--primary);border-radius:4px;font-size:14px;background:var(--bg-card);color:var(--text-main);outline:none;';
    
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    
    function finishRename() {
        const newTitle = input.value.trim();
        if (newTitle && newTitle !== chat.title) {
            chat.title = newTitle;
            void flushChatPersistence();
        }
        renderChatList();
    }
    
    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            input.blur();
        } else if (e.key === 'Escape') {
            input.value = chat.title;
            input.blur();
        }
    });
}

function switchChat(chatId) {
    if (chatIsSending) stopChatGeneration();
    currentChatId = chatId;
    renderChatList();
    syncChatModelSelect();
    renderChatMessages();
    void flushChatPersistence();
}
function deleteChat(chatId) {
    const chat = chatConversations.find(c => c.id === chatId);
    // 1. 先收集待删除图片缓存 Key 集合
    const keysToDelete = chat ? _collectImageKeysFromMessages(chat.messages) : new Set();
    
    // 2. 移除对话，更新状态
    chatConversations = chatConversations.filter(c => c.id !== chatId);
    if (currentChatId === chatId) {
        currentChatId = chatConversations.length > 0 ? chatConversations[0].id : null;
    }
    
    // 3. 刷新 UI
    if (chatConversations.length === 0) {
        createNewChat();
    } else {
        renderChatList();
        renderChatMessages();
    }
    
    // 4. 持久化数据落盘
    void flushChatPersistence();
    
    // 5. 进行安全物理删除（此时对话已彻底从活跃列表中移出，不会产生引用计算冲突）
    if (keysToDelete.size > 0) {
        void _removeImageCacheKeys(keysToDelete);
    }
}

function clearAllChats() {
    if (!confirm('确定要清空所有对话历史吗？\n\n此操作不可恢复，共 ' + chatConversations.length + ' 条对话将被删除。')) return;
    
    // 1. 收集所有将被清空的图片缓存 Key
    const allKeys = new Set();
    for (const chat of chatConversations) {
        for (const key of _collectImageKeysFromMessages(chat.messages)) {
            allKeys.add(key);
        }
    }
    
    // 2. 彻底清空对话，重置状态
    chatConversations = [];
    currentChatId = null;
    createNewChat();
    
    // 3. 数据落盘
    void flushChatPersistence();
    
    // 4. 批量物理释放缓存
    if (allKeys.size > 0) {
        void _removeImageCacheKeys(allKeys);
    }
}

function renderChatFailedImageBlock(img, imgIndex, imgWidth, msg) {
    const reason = formatChatImageErrorReason(img.error || img.reason || '生成失败');
    return `<div class="chat-bubble-img chat-bubble-img-failed" style="width:${imgWidth}px;" data-img-index="${imgIndex}" data-prompt="${escapeHTML(img.prompt || msg.content || '')}" title="${escapeHTML(reason)}"><span class="chat-placeholder-text">生成失败</span><span class="chat-failed-reason">失败：${escapeHTML(reason)}</span></div>`;
}

// ========== 增量聊天渲染（避免每次 innerHTML 全量重建） ==========
// 流式更新：仅更新最后一条AI消息的文本内容，不重建DOM
function updateStreamingBubble(content) {
    const messagesEl = document.getElementById('chatMessages');
    if (!messagesEl) return;
    const inner = messagesEl.querySelector('.chat-messages-inner');
    if (!inner) return;
    const lastMsg = inner.lastElementChild;
    if (!lastMsg) return;
    const bubble = lastMsg.querySelector('.chat-msg-bubble');
    if (!bubble) return;
    // 查找或创建文本div
    let textDiv = bubble.querySelector('.chat-msg-bubble-text');
    if (!textDiv || textDiv.classList.contains('chat-msg-thinking')) {
        // 替换"正在思考..."占位为流式文本
        if (textDiv) textDiv.remove();
        textDiv = document.createElement('div');
        textDiv.className = 'chat-msg-bubble-text';
        bubble.appendChild(textDiv);
    }
    textDiv.innerHTML = escapeHTML(content) + '<span class="stream-cursor"></span>';
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

// 追加单条消息DOM（不重建已有消息）
function appendChatMessageEl(msg, index) {
    const messagesEl = document.getElementById('chatMessages');
    if (!messagesEl) return;
    let inner = messagesEl.querySelector('.chat-messages-inner');
    if (!inner) {
        // 首条消息，需要全量渲染来创建容器
        renderChatMessages();
        return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = `chat-msg ${msg.role}${msg.pending ? ' pending' : ''}${msg.error ? ' error' : ''}`;
    wrapper.setAttribute('data-msg-index', index);
    wrapper.innerHTML = `<div class="chat-msg-content">
        ${msg.role === 'user' && msg.timestamp ? `<div class="chat-msg-time">${formatChatTime(msg.timestamp)}</div>` : ''}
        <div class="chat-msg-bubble" style="position:relative;">${msg.images && msg.images.length > 0 ? `<button type="button" class="chat-collapse-btn" data-action="collapse" title="折叠/展开"><i class="fas fa-compress"></i></button><div class="chat-msg-bubble-images ${msg.images.length > 1 ? 'multi' : 'single'}">${msg.images.map((img, imgIndex) => {
            const aspectRatio = img.aspectRatio || '1:1';
            const ratioMap = { '21:9': 336, '16:9': 256, '3:2': 216, '4:3': 192, '1:1': 144, '3:4': 108, '9:16': 81, '2:3': 96, '4:5': 115, '5:4': 180, '9:21': 62 };
            const imgWidth = ratioMap[aspectRatio] || 144;
            return img.placeholder ? `<div class="chat-bubble-img chat-bubble-img-placeholder" style="width:${imgWidth}px;" data-img-index="${imgIndex}" data-prompt="${escapeHTML(img.prompt || msg.content || '')}"><span class="chat-placeholder-text">${img.source === 'failed' ? '生成失败' : '生成中...'}</span></div>` : (img.source === 'failed' ? renderChatFailedImageBlock(img, imgIndex, imgWidth, msg) : `<img src="${escapeHTML(getSafeImageSrc(img.data || img.url || '', imgWidth, 144))}" class="chat-bubble-img" style="width:${imgWidth}px;" data-img-index="${imgIndex}" data-prompt="${escapeHTML(img.prompt || msg.content || '')}" data-cache-key="${escapeHTML(img.cacheKey || '')}" alt="" />`);
        }).join('')}</div>${msg.imageMeta ? `<div class="chat-msg-bubble-meta">${escapeHTML(msg.imageMeta)}</div>` : ''}` : (msg.content && !msg.pending ? `<button type="button" class="chat-collapse-btn" data-action="collapse" title="折叠/展开"><i class="fas fa-compress"></i></button>` : '')}${msg.pending ? (msg.streaming && msg.content ? `<div class="chat-msg-bubble-text">${escapeHTML(msg.content)}<span class="stream-cursor"></span></div>` : `<div class="chat-msg-bubble-text chat-msg-thinking"><span class="chat-thinking-dot"></span>${escapeHTML(msg.content || '正在思考...')}</div>`) : (msg.content ? `<div class="chat-msg-bubble-text">${escapeHTML(msg.content)}</div>` : '')}${msg.error && msg.imageTask ? `<div class="chat-msg-bubble-actions"><button type="button" class="chat-msg-action-btn" data-action="retry-image"><i class="fas fa-rotate-right"></i> 手动重试</button></div>` : ''}</div>
        <div class="chat-msg-actions">
            <button type="button" class="chat-msg-action-btn" data-action="delete"><i class="fas fa-trash"></i> 删除</button>
            ${!msg.pending ? `<button type="button" class="chat-msg-action-btn" data-action="copy"><i class="fas fa-copy"></i> 复制</button>` : ''}
            ${msg.role === 'user' ? `<button type="button" class="chat-msg-action-btn" data-action="reuse"><i class="fas fa-recycle"></i> 复用</button>` : ''}
            ${msg.role === 'ai' && !msg.pending ? `<button type="button" class="chat-msg-action-btn" data-action="regenerate"><i class="fas fa-redo"></i> 重新生成</button>` : ''}
        </div>
    </div>`;
    inner.appendChild(wrapper);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}


// rAF 合并：同一帧内多次调用只执行一次，避免频繁 innerHTML 全量重建
let _renderChatRafId = 0;
function renderChatMessages() {
    if (_renderChatRafId) return;
    _renderChatRafId = requestAnimationFrame(() => {
        _renderChatRafId = 0;
        _renderChatMessagesNow();
    });
}
function _renderChatMessagesNow() {
    const messagesEl = document.getElementById('chatMessages');
    if (!messagesEl) return;
    
    const chat = chatConversations.find(c => c.id === currentChatId);
    if (!chat || chat.messages.length === 0) {
        messagesEl.innerHTML = `
            <div class="chat-welcome">
                <p>你好，有什么可以帮你的？</p>
            </div>
        `;
        return;
    }
    
    messagesEl.innerHTML = `<div class="chat-messages-inner">${chat.messages.map((msg, index) => `
        <div class="chat-msg ${msg.role}${msg.pending ? ' pending' : ''}${msg.error ? ' error' : ''}" data-msg-index="${index}">
            <div class="chat-msg-content">
                ${msg.role === 'user' && msg.timestamp ? `<div class="chat-msg-time">${formatChatTime(msg.timestamp)}</div>` : ''}
                <div class="chat-msg-bubble" style="position:relative;">${msg.images && msg.images.length > 0 ? `<button type="button" class="chat-collapse-btn" data-action="collapse" title="折叠/展开"><i class="fas fa-compress"></i></button><div class="chat-msg-bubble-images ${msg.images.length > 1 ? 'multi' : 'single'}">${msg.images.map((img, imgIndex) => {
                    // 根据比例计算宽度：固定高度144px，宽度=144*比例
                    const aspectRatio = img.aspectRatio || '1:1';
                    const ratioMap = { '21:9': 336, '16:9': 256, '3:2': 216, '4:3': 192, '1:1': 144, '3:4': 108, '9:16': 81, '2:3': 96, '4:5': 115, '5:4': 180, '9:21': 62 };
                    const imgWidth = ratioMap[aspectRatio] || 144;
                    return img.placeholder ? `<div class="chat-bubble-img chat-bubble-img-placeholder" style="width:${imgWidth}px;" data-img-index="${imgIndex}" data-prompt="${escapeHTML(img.prompt || msg.content || '')}"><span class="chat-placeholder-text">${img.source === 'failed' ? '生成失败' : '生成中...'}</span></div>` : (img.source === 'failed' ? renderChatFailedImageBlock(img, imgIndex, imgWidth, msg) : `<img src="${escapeHTML(getSafeImageSrc(img.data || img.url || '', imgWidth, 144))}" class="chat-bubble-img" style="width:${imgWidth}px;" data-img-index="${imgIndex}" data-prompt="${escapeHTML(img.prompt || msg.content || '')}" data-cache-key="${escapeHTML(img.cacheKey || '')}" alt="" />`);
                }).join('')}</div>${msg.imageMeta ? `<div class="chat-msg-bubble-meta">${escapeHTML(msg.imageMeta)}</div>` : ''}` : (msg.content && !msg.pending ? `<button type="button" class="chat-collapse-btn" data-action="collapse" title="折叠/展开"><i class="fas fa-compress"></i></button>` : '')}${msg.pending ? (msg.streaming && msg.content ? `<div class="chat-msg-bubble-text">${escapeHTML(msg.content)}<span class="stream-cursor"></span></div>` : `<div class="chat-msg-bubble-text chat-msg-thinking"><span class="chat-thinking-dot"></span>${escapeHTML(msg.content || '正在思考...')}</div>`) : (msg.content ? `<div class="chat-msg-bubble-text">${escapeHTML(msg.content)}</div>` : '')}${msg.error && msg.imageTask ? `<div class="chat-msg-bubble-actions"><button type="button" class="chat-msg-action-btn" data-action="retry-image"><i class="fas fa-rotate-right"></i> 手动重试</button></div>` : ''}</div>
                <div class="chat-msg-actions">
                    <button type="button" class="chat-msg-action-btn" data-action="delete"><i class="fas fa-trash"></i> 删除</button>
                    ${!msg.pending ? `
                        <button type="button" class="chat-msg-action-btn" data-action="copy"><i class="fas fa-copy"></i> 复制</button>
                    ` : ''}
                    ${msg.role === 'user' ? `
                        <button type="button" class="chat-msg-action-btn" data-action="reuse"><i class="fas fa-recycle"></i> 复用</button>
                    ` : ''}
                    ${msg.role === 'ai' && !msg.pending ? `
                        <button type="button" class="chat-msg-action-btn" data-action="regenerate"><i class="fas fa-redo"></i> 重新生成</button>
                    ` : ''}
                </div>
            </div>
        </div>
    `).join('')}</div>`;
    
    // 滚动到底部
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // 主动 hydrate：预加载有 cacheKey 但 src 无效的图片
    hydrateChatImages();
}

// 主动从 IndexedDB 恢复聊天图片（避免 onerror 闪烁）
async function hydrateChatImages() {
    const messagesEl = document.getElementById('chatMessages');
    if (!messagesEl) return;
    const imgs = messagesEl.querySelectorAll('img.chat-bubble-img[data-cache-key]');
    for (const img of imgs) {
        const cacheKey = img.dataset.cacheKey;
        if (!cacheKey || img._cacheAttempted) continue;
        // 如果 src 已经是有效 base64/data URL，跳过
        if (img.src && (img.src.startsWith('data:') || img.src.startsWith('blob:'))) continue;
        // 如果 src 是死链占位符或空，主动查缓存
        if (!img.src || img.src === location.href || isDeadImageUrl(img.src)) {
            img._cacheAttempted = true;
            try {
                const cached = await getCachedChatImageFromDB(cacheKey);
                if (cached) {
                    img.src = cached.original || cached.thumbnail || '';
                }
            } catch (_) {}
        }
    }
}

async function sendChatMessage() {
    if (chatIsSending) return;

    const input = document.getElementById('chatInput');
    if (!input) return;
    
    const raw = (input.value || '').replace(/\r\n/g, '\n');
    const contentForCheck = raw.trim();
    const hasImages = chatImages.length > 0;
    if (!contentForCheck && !hasImages) return;
    
    // 立即锁定发送状态，防止异步间隙重复触发
    setChatSendingState(true);
    
    try {
        // 如果没有当前对话，自动创建一个新对话
        if (!currentChatId || !chatConversations.find(c => c.id === currentChatId)) {
            createNewChat();
        }
        
        const chat = chatConversations.find(c => c.id === currentChatId);
        if (!chat) return;

        // 为每张用户上传图片生成cacheKey并缓存到IndexedDB
        const processedImages = hasImages ? await Promise.all(chatImages.map(async (img) => {
            const cacheKey = 'user-img-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
            const srcData = img.previewData || img.data || '';
            if (srcData && srcData.startsWith('data:')) {
                try {
                    const thumbnail = await generateThumbnailFromBase64(srcData, 400, 0.6);
                    await cacheUserUploadImage(cacheKey, thumbnail || srcData, srcData);
                } catch (e) { debugWarn('用户图片缓存失败:', e); }
            }
            return {
                data: srcData,
                previewData: srcData,
                originalName: img.originalName || img.name || '',
                name: img.name || img.originalName || '',
                type: img.type || 'image/jpeg',
                originalSize: img.originalSize || null,
                compressedSize: img.compressedSize || null,
                source: 'chat',
                cacheKey: cacheKey
            };
        })) : [];

        const userMessage = {
            role: 'user',
            content: raw,
            images: processedImages,
            timestamp: Date.now()
        };
        chat.messages.push(userMessage);
        
        if (chat.messages.filter(m => m.role === 'user').length === 1) {
            const titleBase = (contentForCheck || '图片消息').split('\n')[0];
            chat.title = titleBase.slice(0, 20) + (titleBase.length > 20 ? '...' : '');
            renderChatList();
        }
        
        input.value = '';
        input.style.height = 'auto';
        chatImages = [];
        renderChatImagesPreview();
        chat.messages.push({ role: 'ai', content: '正在思考...', pending: true, timestamp: Date.now() });
        // 增量追加：只追加用户消息和AI占位，不重建已有消息
        const userMsgIdx = chat.messages.length - 2;
        const pendingMsgIdx = chat.messages.length - 1;
        appendChatMessageEl(chat.messages[userMsgIdx], userMsgIdx);
        appendChatMessageEl(chat.messages[pendingMsgIdx], pendingMsgIdx);
        void flushChatPersistence();

        // ===== 新流程：轻量分流 =====
        // 用户只看到"正在思考..."，分流判断在后台静默进行
        const imageGenToggle = document.getElementById('chatImageGenToggle');
        const imageGenEnabled = imageGenToggle ? imageGenToggle.checked : true;
        const intentType = imageGenEnabled ? await classifyChatIntent(chat, userMessage) : 'CHAT';

        if (intentType === 'IMAGE_TASK') {
            try {
                // ===== 新流程：深度构思 =====
                const plan = await deepPlanImageRequest(chat, userMessage);

                // analyze_only：只展示分析结果，不生图
                if (plan.mode === 'analyze_only') {
                    const p = chat.messages[chat.messages.length - 1];
                    if (p?.pending) chat.messages.pop();
                    let content = '';
                    if (plan.understanding) content += `**理解需求：** ${plan.understanding}\n\n`;
                    if (plan.plan) content += `**分析结果：**\n${plan.plan}`;
                    if (!content) content = '已分析完成。';
                    chat.messages.push({ role: 'ai', content, timestamp: Date.now() });
                    renderChatMessages();
                    void flushChatPersistence();
                    return;
                }

                // 构建方案展示文本
                const modeText = plan.mode === 'image_to_image' ? '图生图' : (plan.mode === 'analyze_to_text2img' ? '分析后文生图' : '文生图');
                let planContent = `收到，我将按${modeText}为你生成${plan.keywords.length}张图片。\n\n`;
                if (plan.understanding) {
                    planContent += `理解需求：${plan.understanding}\n\n`;
                }
                if (plan.plan) {
                    planContent += `设计方案：${plan.plan}\n\n`;
                }
                plan.keywords.forEach((prompt, idx) => {
                    planContent += `图${idx + 1}：${prompt}\n`;
                });
                planContent += '\n我现在就开始为你生成这组图片。';

                // 替换"正在思考..."为方案展示
                const p = chat.messages[chat.messages.length - 1];
                if (p?.pending) chat.messages.pop();
                chat.messages.push({ role: 'ai', content: planContent, timestamp: Date.now() });
                renderChatMessages();
                void flushChatPersistence();

                // 执行生图
                await executeImageGeneration(chat, userMessage, plan);
            } catch (err) {
                debugLog('sendChatMessage(image):', err);
                const p = chat.messages[chat.messages.length - 1];
                if (p?.pending) chat.messages.pop();
                chat.messages.push({ role: 'ai', content: `生图失败：${formatChatImageErrorReason(err || '请求失败')}`, error: true, timestamp: Date.now() });
                renderChatMessages();
                void flushChatPersistence();
            }
            return;
        }

        // ===== 普通对话 =====
        try {
            await requestChatCompletion(chat);
        } catch (err) {
            debugLog('sendChatMessage:', err);
        }
    } finally {
        setChatSendingState(false);
    }
}

async function regenerateMessage(index) {
    if (chatIsSending) {
        showToast('请等待当前回复完成');
        return;
    }
    const chat = chatConversations.find(c => c.id === currentChatId);
    if (!chat || !chat.messages[index] || chat.messages[index].role !== 'ai') return;

    const msg = chat.messages[index];
    const isImageResult = Array.isArray(msg.images) && msg.images.length > 0;
    const isImagePlan = !isImageResult && msg.content && /理解需求|图生图|文生图|分析后文生图/.test(msg.content);

    // 类型3：图片消息 → 只重新生图
    if (isImageResult) {
        // 提取原有 prompts
        const prompts = msg.images.map(img => img.prompt || '').filter(Boolean);
        if (prompts.length === 0) {
            showToast('无法获取原有关键词，无法重新生成');
            return;
        }
        // 往前找 user 消息，获取参考图
        let userImages = [];
        for (let i = index - 1; i >= 0; i--) {
            if (chat.messages[i].role === 'user') {
                userImages = chat.messages[i].images || [];
                break;
            }
        }
        // 构造 plan 对象
        const userMessage = { content: '', images: userImages };
        const hasRefImages = userImages.length > 0;
        const plan = {
            mode: hasRefImages ? 'image_to_image' : 'text_to_image',
            keywords: prompts,
            count: prompts.length,
            aspectRatio: msg.images[0]?.aspectRatio || 'auto',
            size: '1K',
            negativePrompt: '',
            referencePolicy: hasRefImages ? 'use_reference' : 'no_reference'
        };
        // 删除当前图片消息及之后的所有消息
        chat.messages.splice(index);
        renderChatMessages();
        void flushChatPersistence();
        // 执行生图
        setChatSendingState(true);
        try {
            await executeImageGeneration(chat, userMessage, plan);
        } catch (err) {
            debugLog('regenerateMessage(image):', err);
        } finally {
            setChatSendingState(false);
        }
        return;
    }

    // 类型2：构思消息 → 重新走完整构思+生图流程
    if (isImagePlan) {
        // 往前找 user 消息
        let userMsg = null;
        for (let i = index - 1; i >= 0; i--) {
            if (chat.messages[i].role === 'user') {
                userMsg = chat.messages[i];
                break;
            }
        }
        if (!userMsg) {
            showToast('找不到原始输入，无法重新生成');
            return;
        }
        // 删除构思消息及之后的所有消息
        chat.messages.splice(index);
        renderChatMessages();
        void flushChatPersistence();
        // 添加"正在思考..."
        chat.messages.push({ role: 'ai', content: '正在思考...', pending: true, timestamp: Date.now() });
        renderChatMessages();
        // 重新走完整流程
        const userMessage = { content: userMsg.content || '', images: userMsg.images || [] };
        setChatSendingState(true);
        try {
            const plan = await deepPlanImageRequest(chat, userMessage);
            if (plan.mode === 'analyze_only') {
                const p = chat.messages[chat.messages.length - 1];
                if (p?.pending) chat.messages.pop();
                let content = '';
                if (plan.understanding) content += `**理解需求：** ${plan.understanding}\n\n`;
                if (plan.plan) content += `**分析结果：**\n${plan.plan}`;
                if (!content) content = '已分析完成。';
                chat.messages.push({ role: 'ai', content, timestamp: Date.now() });
                renderChatMessages();
                void flushChatPersistence();
                return;
            }

            const modeText = plan.mode === 'image_to_image' ? '图生图' : (plan.mode === 'analyze_to_text2img' ? '分析后文生图' : '文生图');
            let planContent = `收到，我将按${modeText}为你生成${plan.keywords.length}张图片。\n\n`;
            if (plan.understanding) planContent += `理解需求：${plan.understanding}\n\n`;
            if (plan.plan) planContent += `设计方案：${plan.plan}\n\n`;
            plan.keywords.forEach((prompt, idx) => { planContent += `图${idx + 1}：${prompt}\n`; });
            planContent += '\n我现在就开始为你生成这组图片。';
            const p = chat.messages[chat.messages.length - 1];
            if (p?.pending) chat.messages.pop();
            chat.messages.push({ role: 'ai', content: planContent, timestamp: Date.now() });
            renderChatMessages();
            void flushChatPersistence();
            await executeImageGeneration(chat, userMessage, plan);
        } catch (err) {
            debugLog('regenerateMessage(imagePlan):', err);
        } finally {
            setChatSendingState(false);
        }
        return;
    }

    // 类型1：普通消息 → 重新生成普通对话
    chat.messages.splice(index);
    chat.messages.push({ role: 'ai', content: '正在思考...', pending: true, timestamp: Date.now() });
    renderChatMessages();
    void flushChatPersistence();
    try {
        await requestChatCompletion(chat);
    } catch (err) {
        debugLog('regenerateMessage:', err);
    }
}

function deleteChatMessage(index) {
    if (!confirm('确定要删除这条消息吗？')) return;
    
    const chat = chatConversations.find(c => c.id === currentChatId);
    if (!chat || !chat.messages[index]) return;
    
    // 1. 精确收集这条将被删除消息的图片缓存 Key
    const keysToDelete = _collectImageKeysFromMessages([chat.messages[index]]);
    
    // 2. 物理移出该条消息
    chat.messages.splice(index, 1);
    
    // 3. 渲染 UI 与数据持久化
    renderChatMessages();
    void flushChatPersistence();
    
    // 4. 进行安全物理释放
    if (keysToDelete.size > 0) {
        void _removeImageCacheKeys(keysToDelete);
    }
    
    if (chat.messages.length === 0) {
        renderChatMessages();
    }
}


async function copyMessage(index) {
    const chat = chatConversations.find(c => c.id === currentChatId);
    if (!chat || !chat.messages[index]) return;

    const msg = chat.messages[index];
    const text = String(msg.content || '').trim();
    try {
        await navigator.clipboard.writeText(text);
        showToast('已复制文本');
    } catch {
        showToast('复制失败');
    }
}

async function resolveChatImageSourceForReuse(img) {
    if (!img) return '';
    const direct = img.previewData || img.data || img.url || '';
    if (direct && !String(direct).startsWith('[stripped')) return direct;
    const cacheKey = img.cacheKey || '';
    if (cacheKey) {
        const cached = await getCachedChatImageFromDB(cacheKey);
        if (cached?.original || cached?.thumbnail) return cached.original || cached.thumbnail || '';
    }
    const fallbackKey = img.data || img.url || '';
    if (fallbackKey && !String(fallbackKey).startsWith('[stripped')) {
        const cached = await getCachedChatImageFromDB(fallbackKey);
        if (cached?.original || cached?.thumbnail) return cached.original || cached.thumbnail || '';
    }
    return '';
}

async function reuseChatMessage(index) {
    const chat = chatConversations.find(c => c.id === currentChatId);
    const msg = chat?.messages?.[index];
    if (!chat || !msg) return;

    const input = document.getElementById('chatInput');
    if (!input) return;

    const parts = [];
    if (msg.content) parts.push(msg.content);
    input.value = parts.join('');
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';

    if (Array.isArray(msg.images) && msg.images.length > 0) {
        const reusedImages = await Promise.all(msg.images.map(async (img, idx) => {
            const src = await resolveChatImageSourceForReuse(img);
            return {
                data: src,
                previewData: src,
                name: img.name || img.originalName || `参考图_${idx + 1}`,
                originalName: img.originalName || img.name || `参考图_${idx + 1}`,
                type: img.type || 'image/png',
                id: Date.now() + Math.random() + idx
            };
        }));
        chatImages = reusedImages.filter(img => img.data || img.previewData);
        renderChatImagesPreview();
    }

    input.focus();
    showToast('已复用到输入框');
}

// escapeHtml 已统一为 escapeHTML（正则版，性能更好，见上方定义）

// 处理对话模式图片上传
let chatImages = []; // 支持多图片
let draggedImageIndex = null;

async function handleChatImageUpload(file) {
    if (!file || !file.type.startsWith('image/')) return;
    if (chatImages.length >= CHAT_MAX_IMAGES) {
        showToast(`最多只能添加 ${CHAT_MAX_IMAGES} 张图片`);
        return;
    }

    try {
        const previewData = `data:${file.type};base64,${await fileToBase64(file)}`;
        chatImages.push({
            data: previewData,
            previewData,
            originalName: file.name,
            name: file.name,
            type: file.type,
            id: Date.now() + Math.random(),
            size: file.size
        });
        renderChatImagesPreview();
        showToast(`已添加图片: ${file.name}`);
    } catch (err) {
        debugWarn('handleChatImageUpload:', err);
        showToast('图片处理失败，已取消添加');
    }
}

function renderChatImagesPreview() {
    const previewEl = document.getElementById('chatImagesPreview');
    if (!previewEl) return;
    
    previewEl.innerHTML = '';
    
    if (chatImages.length > 0) {
        previewEl.classList.add('has-images');
    } else {
        previewEl.classList.remove('has-images');
        return;
    }
    
    chatImages.forEach((img, index) => {
        const div = document.createElement('div');
        div.className = 'chat-image-thumb';
        div.dataset.index = index;
        div.style.cursor = 'grab';
        div.addEventListener('mousedown', (e) => startChatImageDrag(e, index));
        div.addEventListener('touchstart', (e) => startChatImageDrag(e, index), { passive: false });
        div.addEventListener('dragstart', (e) => e.preventDefault());
        
        div.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:12px;">加载中...</div>';
        previewEl.appendChild(div);

        const displaySrc = img.previewData || img.data || img.url || '';
        div.innerHTML = `<img src="${escapeAttr(displaySrc)}" alt="${escapeAttr(img.name || img.originalName || '图片')}" draggable="false">
                        <div class="chat-image-label">图${index + 1}</div>
                        <button class="chat-image-remove" onclick="event.stopPropagation(); removeChatImage(${index})"><i class="fas fa-times"></i></button>`;
    });
}

// 长按拖拽排序变量
let chatDraggedIndex = null;
let chatDragLongPressTimer = null;
let chatIsDragging = false;

function startChatImageDrag(e, index) {
    if (chatIsDragging) return;

    const isTouch = e.type === 'touchstart';

    if (chatDragLongPressTimer) {
        clearTimeout(chatDragLongPressTimer);
    }

    chatDragLongPressTimer = setTimeout(() => {
        chatIsDragging = true;
        chatDraggedIndex = index;

        const thumbItems = document.querySelectorAll('.chat-image-thumb');
        thumbItems.forEach(item => {
            if (parseInt(item.dataset.index) === index) {
                item.classList.add('dragging');
            }
        });

        if (isTouch) {
            document.addEventListener('touchmove', handleChatDragMove, { passive: false });
            document.addEventListener('touchend', handleChatDragEnd);
        } else {
            document.addEventListener('mousemove', handleChatDragMove);
            document.addEventListener('mouseup', handleChatDragEnd);
        }
    }, 200);

    const cancelDrag = () => {
        if (chatDragLongPressTimer) {
            clearTimeout(chatDragLongPressTimer);
            chatDragLongPressTimer = null;
        }
    };

    if (isTouch) {
        document.addEventListener('touchend', cancelDrag, { once: true });
    } else {
        document.addEventListener('mouseup', cancelDrag, { once: true });
    }
}

function handleChatDragMove(e) {
    if (!chatIsDragging || chatDraggedIndex === null) return;
    e.preventDefault();
    const moveX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
    const moveY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    const thumbItems = document.querySelectorAll('.chat-image-thumb');
    thumbItems.forEach(item => {
        const itemIndex = parseInt(item.dataset.index);
        if (itemIndex === chatDraggedIndex) return;
        const rect = item.getBoundingClientRect();
        if (moveX >= rect.left && moveX <= rect.right && moveY >= rect.top && moveY <= rect.bottom) {
            item.classList.add('chat-drag-over');
        } else {
            item.classList.remove('chat-drag-over');
        }
    });
}

function handleChatDragEnd(e) {
    if (!chatIsDragging || chatDraggedIndex === null) {
        document.removeEventListener('mousemove', handleChatDragMove);
        document.removeEventListener('mouseup', handleChatDragEnd);
        document.removeEventListener('touchmove', handleChatDragMove);
        document.removeEventListener('touchend', handleChatDragEnd);
        return;
    }
    const isTouch = e.type === 'touchend';
    const clientX = isTouch ? e.changedTouches[0].clientX : e.clientX;
    const clientY = isTouch ? e.changedTouches[0].clientY : e.clientY;
    const thumbItems = document.querySelectorAll('.chat-image-thumb');
    let targetIndex = null;
    thumbItems.forEach(item => {
        item.classList.remove('dragging', 'chat-drag-over');
        const itemIndex = parseInt(item.dataset.index);
        if (itemIndex === chatDraggedIndex) return;
        const rect = item.getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
            targetIndex = itemIndex;
        }
    });
    if (targetIndex !== null && targetIndex !== chatDraggedIndex) {
        const temp = chatImages[chatDraggedIndex];
        chatImages.splice(chatDraggedIndex, 1);
        chatImages.splice(targetIndex, 0, temp);
        showToast('图片顺序已调整');
    }
    chatIsDragging = false;
    chatDraggedIndex = null;
    chatDragLongPressTimer = null;
    renderChatImagesPreview();
    document.removeEventListener('mousemove', handleChatDragMove);
    document.removeEventListener('mouseup', handleChatDragEnd);
    document.removeEventListener('touchmove', handleChatDragMove);
    document.removeEventListener('touchend', handleChatDragEnd);
}

function removeChatImage(index) {
    chatImages.splice(index, 1);
    renderChatImagesPreview();
}

function toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateThemeIcon(next);
}

function updateThemeIcon(theme) {
    const btn = document.getElementById('themeBtn');
    if(btn) {
        btn.innerHTML = theme === 'dark' ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
        btn.title = theme === 'dark' ? '切换日间模式' : '切换夜间模式';
    }
}

function isSuiteArchiveDirectorySupported() {
    return typeof window.showDirectoryPicker === 'function';
}

function openSuiteArchiveConfigDB() {
    if (suiteArchiveConfigDb) return Promise.resolve(suiteArchiveConfigDb);
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('SuiteArchiveConfigDB', 1);
        request.onupgradeneeded = (e) => {
            const archiveDb = e.target.result;
            if (!archiveDb.objectStoreNames.contains('settings')) {
                archiveDb.createObjectStore('settings', { keyPath: 'key' });
            }
        };
        request.onsuccess = (e) => {
            suiteArchiveConfigDb = e.target.result;
            resolve(suiteArchiveConfigDb);
        };
        request.onerror = () => reject(request.error || new Error('打开套图归档配置库失败'));
    });
}

async function saveSuiteArchiveDirectoryHandle(handle) {
    const archiveDb = await openSuiteArchiveConfigDB();
    return new Promise((resolve, reject) => {
        const tx = archiveDb.transaction(['settings'], 'readwrite');
        tx.objectStore('settings').put({
            key: 'directoryHandle',
            handle,
            name: handle?.name || '',
            savedAt: Date.now()
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('保存套图归档目录失败'));
    });
}

async function readSuiteArchiveDirectoryHandle() {
    const archiveDb = await openSuiteArchiveConfigDB();
    return new Promise((resolve, reject) => {
        const tx = archiveDb.transaction(['settings'], 'readonly');
        const req = tx.objectStore('settings').get('directoryHandle');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error('读取套图归档目录失败'));
    });
}

async function clearSuiteArchiveDirectoryHandle() {
    const archiveDb = await openSuiteArchiveConfigDB();
    return new Promise((resolve, reject) => {
        const tx = archiveDb.transaction(['settings'], 'readwrite');
        tx.objectStore('settings').delete('directoryHandle');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('清除套图归档目录失败'));
    });
}

async function querySuiteArchiveDirectoryPermission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') return 'prompt';
    try {
        return await handle.queryPermission({ mode: 'readwrite' });
    } catch (err) {
        console.warn('查询套图归档目录权限失败:', err);
        return 'prompt';
    }
}

async function requestSuiteArchiveDirectoryPermission(handle) {
    if (!handle) return 'denied';
    if (typeof handle.requestPermission !== 'function') return 'granted';
    try {
        return await handle.requestPermission({ mode: 'readwrite' });
    } catch (err) {
        console.warn('请求套图归档目录权限失败:', err);
        return 'denied';
    }
}

async function restoreSuiteArchiveDirectoryHandle() {
    if (!isSuiteArchiveDirectorySupported()) {
        updateSuiteArchiveStatus();
        renderSuiteArchiveStartupNotice();
        return;
    }
    try {
        const saved = await readSuiteArchiveDirectoryHandle();
        if (saved?.handle) {
            suiteArchiveDirectoryHandle = saved.handle;
            suiteArchiveDirectoryName = saved.name || saved.handle.name || localStorage.getItem('suite_archive_dir_name') || '';
            suiteArchiveDirectoryPermission = await querySuiteArchiveDirectoryPermission(saved.handle);
            if (suiteArchiveDirectoryName) {
                localStorage.setItem('suite_archive_dir_name', suiteArchiveDirectoryName);
            }
        }
    } catch (err) {
        console.warn('恢复套图归档目录失败:', err);
    }
    updateSuiteArchiveStatus();
    renderSuiteArchiveStartupNotice();
}

function updateSuiteArchiveStatus() {
    const statusEl = document.getElementById('suiteArchiveStatus');
    const helpEl = document.getElementById('suiteArchiveHelp');
    const dirBtn = document.getElementById('suiteArchiveDirBtn');
    const autoToggle = document.getElementById('suiteAutoArchiveToggle');
    if (!statusEl || !helpEl || !dirBtn || !autoToggle) return;

    const supported = isSuiteArchiveDirectorySupported();
    const autoEnabled = localStorage.getItem('suite_archive_auto') === 'true';
    const savedName = suiteArchiveDirectoryName || localStorage.getItem('suite_archive_dir_name') || '';
    autoToggle.checked = autoEnabled;
    dirBtn.disabled = !supported;
    dirBtn.innerHTML = suiteArchiveDirectoryHandle
        ? '<i class="fas fa-key"></i> 恢复/更换目录'
        : '<i class="fas fa-folder-plus"></i> 选择/更换目录';

    if (!supported) {
        statusEl.textContent = '当前浏览器不支持选择本地目录';
        helpEl.textContent = '建议使用桌面版 Chrome 或 Edge；当前浏览器无法授权写入本地文件夹。';
        return;
    }

    if (suiteArchiveDirectoryHandle) {
        const displayName = suiteArchiveDirectoryHandle.name || savedName || '归档目录';
        if (suiteArchiveDirectoryPermission === 'granted') {
            statusEl.textContent = `已授权目录：${displayName}`;
            helpEl.textContent = '后续归档会在该目录内创建 S260503-001_4张 这类子文件夹。';
        } else if (suiteArchiveDirectoryPermission === 'prompt') {
            statusEl.textContent = `已记住目录：${displayName}（需要恢复授权）`;
            helpEl.textContent = '点击“恢复/更换目录”可尝试恢复上次目录权限；失败时再重新选择目录。';
        } else {
            statusEl.textContent = `目录权限已拒绝：${displayName}`;
            helpEl.textContent = '请点击“恢复/更换目录”重新授权，或清除后重新选择目录。';
        }
        return;
    }

    if (savedName) {
        statusEl.textContent = `上次选择：${savedName}（需要重新授权）`;
        helpEl.textContent = '刷新后通常需要重新点击“选择/更换目录”授权；浏览器不会暴露完整磁盘路径。';
        return;
    }

    statusEl.textContent = autoEnabled ? '自动归档已开启，请先选择归档目录' : '未选择归档目录';
    helpEl.textContent = '浏览器不会暴露完整磁盘路径，也不能直接打开系统文件夹；归档会写入你授权的目录。';
}

function initSuiteArchiveSettings() {
    const autoToggle = document.getElementById('suiteAutoArchiveToggle');
    if (!autoToggle) return;
    autoToggle.checked = localStorage.getItem('suite_archive_auto') === 'true';
    autoToggle.addEventListener('change', (e) => {
        const checked = e.target.checked;
        localStorage.setItem('suite_archive_auto', checked ? 'true' : 'false');
        if (typeof showToast === 'function') {
            showToast(checked ? '已开启套图自动归档' : '已关闭套图自动归档');
        }
        if (checked && !suiteArchiveDirectoryHandle && isSuiteArchiveDirectorySupported()) {
            const savedName = localStorage.getItem('suite_archive_dir_name') || '';
            if (!savedName && typeof showToast === 'function') {
                showToast('请先选择套图归档目录', 'warning');
            }
        }
        updateSuiteArchiveStatus();
    });
    restoreSuiteArchiveDirectoryHandle();
}

async function chooseSuiteArchiveDirectory() {
    if (!isSuiteArchiveDirectorySupported()) {
        alert('当前浏览器不支持选择本地目录，建议使用桌面版 Chrome 或 Edge。');
        updateSuiteArchiveStatus();
        return;
    }

    try {
        if (suiteArchiveDirectoryHandle && suiteArchiveDirectoryPermission !== 'granted') {
            suiteArchiveDirectoryPermission = await requestSuiteArchiveDirectoryPermission(suiteArchiveDirectoryHandle);
            if (suiteArchiveDirectoryPermission === 'granted') {
                suiteArchiveDirectoryName = suiteArchiveDirectoryHandle.name || suiteArchiveDirectoryName || '归档目录';
                localStorage.setItem('suite_archive_dir_name', suiteArchiveDirectoryName);
                updateSuiteArchiveStatus();
                if (typeof showToast === 'function') {
                    showToast('已恢复套图归档目录授权');
                }
                return;
            }
        }

        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        suiteArchiveDirectoryHandle = handle;
        suiteArchiveDirectoryName = handle.name || '归档目录';
        suiteArchiveDirectoryPermission = await querySuiteArchiveDirectoryPermission(handle);
        if (suiteArchiveDirectoryPermission !== 'granted') {
            suiteArchiveDirectoryPermission = await requestSuiteArchiveDirectoryPermission(handle);
        }
        await saveSuiteArchiveDirectoryHandle(handle);
        localStorage.setItem('suite_archive_dir_name', suiteArchiveDirectoryName);
        updateSuiteArchiveStatus();
        if (typeof showToast === 'function') {
            showToast('已选择套图归档目录');
        }
    } catch (err) {
        if (err && err.name !== 'AbortError') {
            console.warn('选择套图归档目录失败:', err);
            alert('选择归档目录失败：' + (err.message || err));
        }
        updateSuiteArchiveStatus();
    }
}

async function clearSuiteArchiveDirectory() {
    suiteArchiveDirectoryHandle = null;
    suiteArchiveDirectoryPermission = 'none';
    suiteArchiveDirectoryName = '';
    localStorage.removeItem('suite_archive_dir_name');
    clearSuiteArchiveDirectoryHandle().catch(err => {
        console.warn('清除套图归档目录句柄失败:', err);
    });
    updateSuiteArchiveStatus();
    renderSuiteArchiveStartupNotice();
    if (typeof showToast === 'function') {
        showToast('已清除套图归档目录授权');
    }
}

function getSuiteArchiveStartupNoticeContent() {
    const autoEnabled = localStorage.getItem('suite_archive_auto') === 'true';
    const supported = isSuiteArchiveDirectorySupported();
    const name = suiteArchiveDirectoryName || localStorage.getItem('suite_archive_dir_name') || '';

    if (!supported) {
        return {
            color: '#ef4444',
            icon: 'fa-circle-xmark',
            title: '套图归档不可用',
            message: '当前浏览器不支持本地目录授权，建议使用桌面版 Chrome 或 Edge。'
        };
    }

    if (!autoEnabled) {
        return {
            color: '#6b7280',
            icon: 'fa-circle-info',
            title: '套图自动归档已关闭',
            message: name ? `上次目录：${name}。需要时可到设置中开启自动归档。` : '当前不会自动保存套图结果，可到设置中开启并选择目录。'
        };
    }

    if (suiteArchiveDirectoryHandle && suiteArchiveDirectoryPermission === 'granted') {
        return {
            color: '#10b981',
            icon: 'fa-circle-check',
            title: '套图自动归档已开启',
            message: `归档目录已授权：${suiteArchiveDirectoryHandle.name || name || '归档目录'}。`
        };
    }

    if (suiteArchiveDirectoryHandle && suiteArchiveDirectoryPermission === 'prompt') {
        return {
            color: '#f59e0b',
            icon: 'fa-circle-exclamation',
            title: '套图自动归档需恢复授权',
            message: `已记住目录：${suiteArchiveDirectoryHandle.name || name || '归档目录'}，请点击查看设置恢复权限。`
        };
    }

    if (suiteArchiveDirectoryHandle && suiteArchiveDirectoryPermission === 'denied') {
        return {
            color: '#ef4444',
            icon: 'fa-circle-xmark',
            title: '套图归档目录权限被拒绝',
            message: `目录：${suiteArchiveDirectoryHandle.name || name || '归档目录'}，请到设置中重新授权。`
        };
    }

    return {
        color: '#f59e0b',
        icon: 'fa-circle-exclamation',
        title: '套图自动归档已开启',
        message: name ? `上次目录：${name}，需要重新授权后才能自动归档。` : '尚未选择归档目录，请先到设置中选择目录。'
    };
}

function dismissSuiteArchiveStartupNotice() {
    const container = document.getElementById('suiteArchiveStartupNotice');
    if (container) container.remove();
}

function openSuiteArchiveSettingsFromNotice() {
    const panel = document.getElementById('settingsPanel');
    if (panel) panel.classList.add('open');
    setTimeout(() => {
        const archiveBox = document.querySelector('.suite-archive-settings');
        if (!archiveBox) return;
        const panelRect = panel?.getBoundingClientRect();
        const archiveRect = archiveBox.getBoundingClientRect();
        if (panel && panelRect) {
            panel.scrollTop = panel.scrollTop + archiveRect.top - panelRect.top - 16;
        } else {
            archiveBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        archiveBox.classList.add('highlight');
        setTimeout(() => archiveBox.classList.remove('highlight'), 1800);
    }, 80);
}

function renderSuiteArchiveStartupNotice() {
    const notice = getSuiteArchiveStartupNoticeContent();
    let container = document.getElementById('suiteArchiveStartupNotice');
    if (!container) {
        container = document.createElement('div');
        container.id = 'suiteArchiveStartupNotice';
        document.body.appendChild(container);
    }

    container.style.cssText = `
        position: fixed;
        top: 76px;
        right: 18px;
        width: min(360px, calc(100vw - 36px));
        z-index: 9997;
        pointer-events: auto;
    `;

    container.innerHTML = `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-left:4px solid ${notice.color};box-shadow:0 10px 28px rgba(0,0,0,0.18);border-radius:12px;padding:12px;">
            <div style="display:flex;gap:10px;align-items:flex-start;">
                <i class="fas ${notice.icon}" style="color:${notice.color};font-size:18px;margin-top:2px;"></i>
                <div style="flex:1;min-width:0;">
                    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
                        <strong style="font-size:14px;color:var(--text-main);">${escapeHTML(notice.title)}</strong>
                    </div>
                    <div style="font-size:12px;color:var(--text-sub);margin-top:4px;line-height:1.4;">${escapeHTML(notice.message)}</div>
                    <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;">
                        <button type="button" data-suite-archive-dismiss class="btn-secondary" style="padding:5px 10px;font-size:12px;border-radius:8px;">知道了</button>
                        <button type="button" data-suite-archive-settings style="padding:5px 10px;font-size:12px;border-radius:8px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer;">查看设置</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    container.querySelector('[data-suite-archive-dismiss]').onclick = (event) => {
        event.stopPropagation();
        dismissSuiteArchiveStartupNotice();
    };
    container.querySelector('[data-suite-archive-settings]').onclick = (event) => {
        event.stopPropagation();
        openSuiteArchiveSettingsFromNotice();
        dismissSuiteArchiveStartupNotice();
    };
    container.onclick = (event) => event.stopPropagation();

    // 5秒无操作自动消失
    setTimeout(function() {
        var c = document.getElementById('suiteArchiveStartupNotice');
        if (c) c.remove();
    }, 5000);
}

function getSuiteArchiveDateCode(date = new Date()) {
    const yy = String(date.getFullYear()).slice(-2);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yy}${mm}${dd}`;
}

function getNextSuiteArchiveCode() {
    const dateCode = getSuiteArchiveDateCode();
    const key = `suite_archive_sequence_${dateCode}`;
    const next = Number(localStorage.getItem(key) || '0') + 1;
    localStorage.setItem(key, String(next));
    return `S${dateCode}-${String(next).padStart(3, '0')}`;
}

function sanitizeSuiteArchiveName(name) {
    return String(name || '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || '套图归档';
}

function getSuiteArchiveImageExt(blob, imageUrl = '') {
    const type = String(blob?.type || '').toLowerCase();
    if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
    if (type.includes('webp')) return 'webp';
    if (type.includes('gif')) return 'gif';
    if (type.includes('bmp')) return 'bmp';
    const match = String(imageUrl || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
    if (match) return match[1].toLowerCase();
    return 'png';
}

async function ensureSuiteArchiveWritableDirectory() {
    if (!isSuiteArchiveDirectorySupported()) {
        throw new Error('当前浏览器不支持选择本地目录，请使用桌面版 Chrome 或 Edge。');
    }
    if (!suiteArchiveDirectoryHandle) {
        await chooseSuiteArchiveDirectory();
    }
    if (!suiteArchiveDirectoryHandle) {
        throw new Error('未选择套图归档目录。');
    }
    suiteArchiveDirectoryPermission = await querySuiteArchiveDirectoryPermission(suiteArchiveDirectoryHandle);
    if (suiteArchiveDirectoryPermission !== 'granted') {
        suiteArchiveDirectoryPermission = await requestSuiteArchiveDirectoryPermission(suiteArchiveDirectoryHandle);
    }
    updateSuiteArchiveStatus();
    if (suiteArchiveDirectoryPermission !== 'granted') {
        throw new Error('套图归档目录未授权写入。');
    }
    return suiteArchiveDirectoryHandle;
}

async function writeTextFileToDirectory(dirHandle, fileName, text) {
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    await writable.close();
}

async function writeBlobFileToDirectory(dirHandle, fileName, blob) {
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
}

async function fetchSuiteArchiveImageBlob(imageUrl) {
    const url = String(imageUrl || '').trim();
    if (!url) throw new Error('图片地址为空');
    if (url.startsWith('data:')) {
        return await (await fetch(url)).blob();
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
    return await response.blob();
}

async function fetchSuiteArchiveImageBlobFromItem(img) {
    const cachedBlob = img?.archiveBlob instanceof Blob ? img.archiveBlob : null;
    const cachedUrl = img?.archiveDataUrl || '';
    try {
        if (img?.imageUrl) return await fetchSuiteArchiveImageBlob(img.imageUrl);
        if (cachedBlob) return cachedBlob;
        return await fetchSuiteArchiveImageBlob(cachedUrl);
    } catch (err) {
        if (cachedBlob) return cachedBlob;
        if (cachedUrl && cachedUrl !== img?.imageUrl) {
            return await fetchSuiteArchiveImageBlob(cachedUrl);
        }
        throw err;
    }
}

function blobToSuiteArchiveDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result || '');
        reader.onerror = () => reject(reader.error || new Error('图片缓存失败'));
        reader.readAsDataURL(blob);
    });
}

function getSuiteArchiveCachedImageUrl(img) {
    if (!img) return '';
    if (img.archiveDataUrl) return img.archiveDataUrl;
    if (img._objectUrl) return img._objectUrl; // 👈 优先重用已创建过的 URL，彻底切断内存泄露
    if (img.archiveBlob instanceof Blob) {
        img._objectUrl = URL.createObjectURL(img.archiveBlob);
        return img._objectUrl;
    }
    return '';
}

async function getSuiteArchiveSavedFileUrl(item, img, allowPermissionRequest = false, grantedDirectoryHandle = null) {
    if (item?.archiveStatus !== 'archived') return '';
    if (img?._savedFileUrl) return img._savedFileUrl; // 👈 优先重用已读取并创建过的 URL

    const directoryHandle = grantedDirectoryHandle || suiteArchiveDirectoryHandle;
    if (!directoryHandle || !item?.archiveFolderName || !img?.archiveFileName) {
        console.warn('跳过本地归档文件读取：缺少必要信息', {
            hasDirectoryHandle: !!directoryHandle,
            archiveFolderName: item?.archiveFolderName || '',
            archiveFileName: img?.archiveFileName || '',
            archiveCode: item?.archiveCode || ''
        });
        return '';
    }
    try {
        if (!grantedDirectoryHandle) {
            let permission = await querySuiteArchiveDirectoryPermission(directoryHandle);
            if (permission !== 'granted' && allowPermissionRequest) {
                permission = await requestSuiteArchiveDirectoryPermission(directoryHandle);
            }
            if (permission !== 'granted') {
                console.warn('跳过本地归档文件读取：归档目录未授权', {
                    permission,
                    archiveFolderName: item.archiveFolderName,
                    archiveFileName: img.archiveFileName
                });
                return '';
            }
        }
        debugLog('尝试读取本地归档文件:', {
            rootDirectoryName: directoryHandle.name || '',
            archiveFolderName: item.archiveFolderName,
            archiveFileName: img.archiveFileName,
            archiveCode: item.archiveCode || ''
        });
        const suiteDir = directoryHandle.name === item.archiveFolderName
            ? directoryHandle
            : await directoryHandle.getDirectoryHandle(item.archiveFolderName);
        const fileHandle = await suiteDir.getFileHandle(img.archiveFileName);
        const file = await fileHandle.getFile();
        if (!file.type.startsWith('image/')) return '';
        
        const url = URL.createObjectURL(file);
        img._savedFileUrl = url; // 👈 缓存创建的对象 URL 句柄
        return url;
    } catch (err) {
        console.warn('读取套图归档文件失败:', err);
        return '';
    }
}

function buildSuiteArchivePromptsText(item, images, archiveCode) {
    const lines = [
        `归档编号：${archiveCode}`,
        `历史ID：${item.id || ''}`,
        `生成时间：${item.timestamp ? new Date(item.timestamp).toLocaleString() : ''}`,
        `归档时间：${new Date().toLocaleString()}`,
        `模型：${item.model || ''}`,
        `反推模型：${item.vlModel || ''}`,
        `比例：${item.ratio || ''}`,
        `尺寸：${item.size || ''}`,
        '',
        '套图规则：',
        item.rule || item.prompt || '',
        '',
        '卡槽提示词：'
    ];
    images.forEach((img, idx) => {
        lines.push('');
        lines.push(`${String(idx + 1).padStart(2, '0')}. 卡槽 ${img.index || idx + 1}`);
        lines.push(img.keyword || item.keywords?.[idx] || '');
        if (img.actualSize) lines.push(`实际尺寸：${img.actualSize}`);
        if (img.imageUrl) lines.push(`原始地址：${img.imageUrl}`);
    });
    return lines.join('\n');
}

function buildSuiteArchiveMetadata(item, images, archiveCode, folderName, savedFiles) {
    return {
        archiveCode,
        folderName,
        archivedAt: new Date().toISOString(),
        historyId: item.id || null,
        taskId: item.taskId || '',
        status: item.status || '',
        prompt: item.prompt || '',
        rule: item.rule || '',
        keywords: item.keywords || [],
        model: item.model || '',
        vlModel: item.vlModel || '',
        ratio: item.ratio || '',
        size: item.size || '',
        count: item.count || images.length,
        images: images.map((img, idx) => ({
            index: img.index || idx + 1,
            keyword: img.keyword || item.keywords?.[idx] || '',
            imageUrl: img.imageUrl || '',
            actualSize: img.actualSize || null,
            fileName: savedFiles[idx] || ''
        })),
        failedSlots: item.failedSlots || [],
        error: item.error || ''
    };
}

async function readSuiteHistoryItemById(itemId) {
    if (!db) throw new Error('数据库未初始化，请刷新页面后重试。');
    const item = await readHistoryItemById(Number(itemId));
    if (!item) throw new Error('找不到该套图历史记录。');
    if (item.type !== 'suite') throw new Error('该记录不是套图记录。');
    return item;
}

async function archiveSuiteHistoryItem(itemId) {
    archiveSuiteHistoryItem.runningIds = archiveSuiteHistoryItem.runningIds || new Set();
    const runningKey = String(itemId || '');
    if (archiveSuiteHistoryItem.runningIds.has(runningKey)) {
        showToast('该套图正在归档中，请稍候', 'warning');
        return;
    }
    archiveSuiteHistoryItem.runningIds.add(runningKey);
    try {
        const rootDir = await ensureSuiteArchiveWritableDirectory();
        const item = await readSuiteHistoryItemById(itemId);
        const images = Array.isArray(item.images)
            ? item.images.filter(img => img && (img.imageUrl || img.archiveDataUrl)).slice().sort((a, b) => (a.index || 0) - (b.index || 0))
            : [];
        if (images.length === 0) {
            showToast('该套图没有可归档图片', 'warning');
            return;
        }

        showToast('正在准备归档图片...');
        const preparedFiles = [];
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            const blob = await fetchSuiteArchiveImageBlobFromItem(img);
            const ext = getSuiteArchiveImageExt(blob, img.imageUrl);
            const fileName = `${String(i + 1).padStart(2, '0')}.${ext}`;
            preparedFiles.push({ fileName, blob });
        }
        if (preparedFiles.length === 0) {
            showToast('该套图没有可归档图片', 'warning');
            return;
        }

        const archiveCode = item.archiveCode || getNextSuiteArchiveCode();
        const folderName = sanitizeSuiteArchiveName(`${archiveCode}_${preparedFiles.length}张`);
        const suiteDir = await rootDir.getDirectoryHandle(folderName, { create: true });
        const savedFiles = [];

        showToast(`开始归档 ${archiveCode}...`);
        for (const file of preparedFiles) {
            await writeBlobFileToDirectory(suiteDir, file.fileName, file.blob);
            savedFiles.push(file.fileName);
        }

        await writeTextFileToDirectory(suiteDir, 'prompts.txt', buildSuiteArchivePromptsText(item, images, archiveCode));
        await writeTextFileToDirectory(
            suiteDir,
            'metadata.json',
            JSON.stringify(buildSuiteArchiveMetadata(item, images, archiveCode, folderName, savedFiles), null, 2)
        );

        const updateResult = await updateSuiteHistoryInDB(Number(itemId), {
            images: images.map((img, idx) => ({
                ...img,
                archiveFileName: savedFiles[idx] || '',
                archiveBlob: preparedFiles[idx]?.blob || img.archiveBlob || null,
                archiveDataUrl: img.archiveDataUrl || ''
            })),
            archiveStatus: 'archived',
            archiveCode,
            archiveDirName: suiteArchiveDirectoryHandle?.name || suiteArchiveDirectoryName || '',
            archiveFolderName: folderName,
            archiveImageCount: images.length,
            archivedAt: Date.now()
        });
        if (!updateResult) {
            throw new Error('本地文件已写入，但历史缓存保存失败，请检查浏览器存储空间后重试。');
        }
        debugLog('套图归档历史缓存已保存:', {
            archiveCode,
            folderName,
            images: images.map((img, idx) => ({
                index: img.index || idx + 1,
                fileName: savedFiles[idx] || '',
                blobType: preparedFiles[idx]?.blob?.type || '',
                blobSize: preparedFiles[idx]?.blob?.size || 0
            }))
        });
        if (typeof loadHistory === 'function') loadHistory();
        showToast(`归档完成：${archiveCode}`);
    } catch (err) {
        console.error('套图归档失败:', err);
        showToast(`归档失败：${err.message || err}`, 'error');
    } finally {
        archiveSuiteHistoryItem.runningIds.delete(runningKey);
    }
}

function toggleSettingsPanel(event) {
    if (event) event.stopPropagation();
    const panel = document.getElementById('settingsPanel');
    syncDebugLogToggle();
    if (panel) panel.classList.toggle('open');
}

function closeSettingsPanel() {
    const panel = document.getElementById('settingsPanel');
    if (panel) panel.classList.remove('open');
}

document.addEventListener('click', (event) => {
    const panel = document.getElementById('settingsPanel');
    if (!panel || !panel.classList.contains('open')) return;
    if (event.target.closest('.settings-popover')) return;
    closeSettingsPanel();
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSettingsPanel();
});

function showDebugInfo() {
    alert(
        "调试信息查看方式：\n\n" +
        "1. 按 F12 打开浏览器开发者工具\n" +
        "2. 点击「控制台」(Console) 标签\n" +
        "3. 查看日志信息\n\n" +
        "图片生成使用 Banana API\n" +
        "图片反推使用 Chat Completions API"
    );
}

function toggleTokenVisibility(icon) {
    const wrapper = icon.closest('.token-input-wrapper');
    const input = wrapper.querySelector('input');
    if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
        icon.className = input.type === 'password' ? 'fas fa-eye-slash token-toggle' : 'fas fa-eye token-toggle';
    }
}

function handleFileSelect(input) {
    if (input.files.length > 0) {
        addFiles(Array.from(input.files));
        input.value = '';
    }
}

function addFiles(newFiles) {
    const mode = document.getElementById('modeSelect').value;
    const maxFiles = mode === 'image-generation' ? 8 : 5;

    if (uploadedFiles.length + newFiles.length > maxFiles) {
        alert(mode === 'image-generation' ? "最多只能上传 8 张参考图片" : "最多只能上传 5 张图片");
        return;
    }
    uploadedFiles = [...uploadedFiles, ...newFiles];
    renderPreviews();
}

function removeFile(index) {
    uploadedFiles.splice(index, 1);
    renderPreviews();
}

// 拖拽排序相关变量
let draggedThumbIndex = null;
let dragLongPressTimer = null;
let isDragging = false;

function renderPreviews() {
    const bar = document.getElementById('previewBar');
    bar.innerHTML = '';
    if (uploadedFiles.length > 0) {
        bar.classList.add('has-items');
        uploadedFiles.forEach((file, index) => {
            const div = document.createElement('div');
            div.className = 'thumb-item';
            div.dataset.index = index;
            div.style.cursor = 'grab';

            // 添加拖拽事件
            div.addEventListener('mousedown', (e) => startDrag(e, index));
            div.addEventListener('touchstart', (e) => startDrag(e, index), { passive: false });
            div.addEventListener('dragstart', (e) => e.preventDefault());

            if (file.type.startsWith('image/')) {
                div.innerHTML = '<div style="width:100%;height:100%;background:#f3f4f6;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:12px;">加载中...</div>';
                bar.appendChild(div);

                const reader = new FileReader();
                reader.onload = (e) => {
                    const imgSrc = e.target.result;
                    div.innerHTML = '';
                    const img = document.createElement('img');
                    img.src = imgSrc;
                    img.draggable = false;
                    img.addEventListener('click', () => previewUpload(imgSrc, `参考图${index + 1}`));
                    const badge = document.createElement('div');
                    badge.style.cssText = 'position: absolute; top: 2px; left: 2px; background: rgba(99, 102, 241, 0.9); color: white; font-size: 10px; font-weight: bold; padding: 2px 4px; border-radius: 3px; pointer-events: none;';
                    badge.textContent = `图${index + 1}`;
                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'thumb-remove';
                    removeBtn.innerHTML = '<i class="fas fa-times"></i>';
                    removeBtn.addEventListener('click', (event) => {
                        event.stopPropagation();
                        removeFile(index);
                    });
                    div.appendChild(img);
                    div.appendChild(badge);
                    div.appendChild(removeBtn);
                };
                reader.readAsDataURL(file);
            } else {
                div.style.background = '#d1d5db';
                div.style.display = 'flex';
                div.style.flexDirection = 'column';
                div.style.alignItems = 'center';
                div.style.justifyContent = 'center';
                div.innerHTML = `<i class="fas fa-file" style="color: #6b7280; font-size: 24px;"></i>
                                <div style="font-size: 9px; color: #6b7280; margin-top: 4px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 90%;">${escapeHTML(file.name)}</div>
                                <button class="thumb-remove" onclick="event.stopPropagation(); removeFile(${index})"><i class="fas fa-times"></i></button>`;
                bar.appendChild(div);
            }
        });
    } else {
        bar.classList.remove('has-items');
    }
    setTimeout(() => {
        const scrollArea = document.getElementById("scrollArea");
        if(scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
    }, 100);
}

// 开始拖拽（长按触发）
function startDrag(e, index) {
    if (isDragging) return;
    
    const isTouch = e.type === 'touchstart';
    const clientX = isTouch ? e.touches[0].clientX : e.clientX;
    const clientY = isTouch ? e.touches[0].clientY : e.clientY;
    
    // 清除之前的定时器
    if (dragLongPressTimer) {
        clearTimeout(dragLongPressTimer);
    }
    
    // 长按 200ms 后开始拖拽
    dragLongPressTimer = setTimeout(() => {
        isDragging = true;
        draggedThumbIndex = index;
        
        const thumbItems = document.querySelectorAll('.thumb-item');
        thumbItems.forEach(item => {
            if (parseInt(item.dataset.index) === index) {
                item.classList.add('dragging');
                item.style.cursor = 'grabbing';
            }
        });
        
        // 添加移动和结束事件监听
        if (isTouch) {
            document.addEventListener('touchmove', handleDragMove, { passive: false });
            document.addEventListener('touchend', handleDragEnd);
        } else {
            document.addEventListener('mousemove', handleDragMove);
            document.addEventListener('mouseup', handleDragEnd);
        }
    }, 200);
    
    // 添加临时结束监听（如果没有长按就松开）
    const cancelDrag = () => {
        if (dragLongPressTimer) {
            clearTimeout(dragLongPressTimer);
            dragLongPressTimer = null;
        }
    };
    
    if (isTouch) {
        document.addEventListener('touchend', cancelDrag, { once: true });
    } else {
        document.addEventListener('mouseup', cancelDrag, { once: true });
    }
}

// 拖拽移动
function handleDragMove(e) {
    if (!isDragging || draggedThumbIndex === null) return;
    
    e.preventDefault();
    
    const isTouch = e.type === 'touchmove';
    const clientX = isTouch ? e.touches[0].clientX : e.clientX;
    const clientY = isTouch ? e.touches[0].clientY : e.clientY;
    
    const thumbItems = document.querySelectorAll('.thumb-item');
    const bar = document.getElementById('previewBar');
    const barRect = bar.getBoundingClientRect();
    
    thumbItems.forEach(item => {
        const itemIndex = parseInt(item.dataset.index);
        if (itemIndex === draggedThumbIndex) return;
        
        const itemRect = item.getBoundingClientRect();
        const itemCenterX = itemRect.left + itemRect.width / 2;
        const itemCenterY = itemRect.top + itemRect.height / 2;
        
        // 检查鼠标/触摸点是否在卡片范围内
        if (clientX >= itemRect.left && clientX <= itemRect.right &&
            clientY >= itemRect.top && clientY <= itemRect.bottom) {
            item.classList.add('drag-over');
        } else {
            item.classList.remove('drag-over');
        }
    });
}

// 结束拖拽
function handleDragEnd(e) {
    if (!isDragging) {
        // 清理事件监听
        document.removeEventListener('mousemove', handleDragMove);
        document.removeEventListener('mouseup', handleDragEnd);
        document.removeEventListener('touchmove', handleDragMove);
        document.removeEventListener('touchend', handleDragEnd);
        return;
    }
    
    const isTouch = e.type === 'touchend';
    const clientX = isTouch ? e.changedTouches[0].clientX : e.clientX;
    const clientY = isTouch ? e.changedTouches[0].clientY : e.clientY;
    
    // 找到放置目标
    const thumbItems = document.querySelectorAll('.thumb-item');
    let targetIndex = null;
    
    thumbItems.forEach(item => {
        item.classList.remove('dragging', 'drag-over');
        item.style.cursor = 'grab';

        const itemIndex = parseInt(item.dataset.index);
        if (itemIndex === draggedThumbIndex) return;
        
        const itemRect = item.getBoundingClientRect();
        if (clientX >= itemRect.left && clientX <= itemRect.right &&
            clientY >= itemRect.top && clientY <= itemRect.bottom) {
            targetIndex = itemIndex;
        }
    });
    
    // 执行交换
    if (targetIndex !== null && targetIndex !== draggedThumbIndex) {
        const temp = uploadedFiles[draggedThumbIndex];
        uploadedFiles.splice(draggedThumbIndex, 1);
        uploadedFiles.splice(targetIndex, 0, temp);
        renderPreviews();
        showToast('图片顺序已调整');
    }
    
    // 清理状态
    isDragging = false;
    draggedThumbIndex = null;
    dragLongPressTimer = null;
    
    // 移除事件监听
    document.removeEventListener('mousemove', handleDragMove);
    document.removeEventListener('mouseup', handleDragEnd);
    document.removeEventListener('touchmove', handleDragMove);
    document.removeEventListener('touchend', handleDragEnd);
}

function fileToBase64(file) {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.readAsDataURL(file);
    });
}

// 图片压缩函数（用于 Qwen3 模型，限制 5MB 文件大小 + 2048x2048 尺寸）
// 使用 createImageBitmap 异步处理，减少主线程阻塞
async function compressImage(file, maxSizeMB = 5, maxDimension = 2048) {
    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    
    // 检查是否需要处理
    if (file.size <= maxSizeBytes && file.type !== 'image/gif') {
        // 检查尺寸需要单独加载图片
        const bitmap = await createImageBitmap(file);
        const { width, height } = bitmap;
        bitmap.close();
        
        if (width <= maxDimension && height <= maxDimension) {
            debugLog(`📷 图片无需压缩: 尺寸 ${width}x${height}，大小 ${formatFileSize(file.size)}`);
            return file;
        }
    }
    
    debugLog(`📷 开始处理: 原始大小 ${formatFileSize(file.size)}`);
    
    // 使用 createImageBitmap 异步加载图片
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;
    const originalWidth = width;
    const originalHeight = height;
    
    // 首先检查尺寸是否超过限制
    let needsResize = false;
    if (width > maxDimension || height > maxDimension) {
        const ratio = Math.min(maxDimension / width, maxDimension / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
        needsResize = true;
        debugLog(`📷 尺寸超限: ${originalWidth}x${originalHeight}，需要缩放到 ${width}x${height}`);
    }
    
    // 创建离屏 canvas 进行压缩
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    
    let quality = 0.9;
    let blob;
    
    // 迭代压缩直到满足大小要求
    while (quality >= 0.1) {
        blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        debugLog(`📷 压缩中: 质量=${quality.toFixed(2)}, 尺寸=${width}x${height}, 大小=${formatFileSize(blob.size)}`);
        
        if (blob.size <= maxSizeBytes) {
            break;
        }
        
        // 文件大小超限，降低质量
        quality -= 0.1;
    }
    
    // 如果降低质量仍不满足，缩小尺寸
    let currentWidth = width;
    let currentHeight = height;
    while (blob.size > maxSizeBytes && currentWidth > 100 && currentHeight > 100) {
        currentWidth = Math.round(currentWidth * 0.9);
        currentHeight = Math.round(currentHeight * 0.9);
        
        const smallCanvas = new OffscreenCanvas(currentWidth, currentHeight);
        const smallCtx = smallCanvas.getContext('2d');
        
        // 重新从原始位图绘制
        const originalBitmap = await createImageBitmap(file);
        smallCtx.drawImage(originalBitmap, 0, 0, currentWidth, currentHeight);
        originalBitmap.close();
        
        blob = await smallCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
        debugLog(`📷 缩小尺寸: → ${currentWidth}x${currentHeight}, 大小=${formatFileSize(blob.size)}`);
    }
    
    const compressedFile = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), {
        type: 'image/jpeg',
        lastModified: Date.now()
    });
    debugLog(`✅ 压缩完成: ${originalWidth}x${originalHeight} ${formatFileSize(file.size)} → ${currentWidth}x${currentHeight} ${formatFileSize(compressedFile.size)}`);
    
    return compressedFile;
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function previewUpload(src, label) {
    openPreviewFromUrl(src, label || '参考图');
}

function scrollToBottom() {
    const scrollArea = document.getElementById("scrollArea");
    if (scrollArea) {
        setTimeout(() => {
            scrollArea.scrollTop = scrollArea.scrollHeight;
        }, 100);
    }
}

function escapeHTML(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
// 专用于 HTML 属性值的转义（额外处理换行、反斜杠等）
function escapeAttr(str) {
    return escapeHTML(str).replace(/\n/g, '&#10;').replace(/\r/g, '').replace(/\\/g, '&#92;');
}

// 转义HTML并保留换行符（用于模板显示）
function escapeHTMLWithLineBreak(str) {
    return escapeHTML(str).replace(/\n/g, '<br>');
}

// 复用提示词（从结果卡片）
function reuseHistoryItem(filesInfo, promptText) {
    const promptInput = document.getElementById('prompt');
    if (promptInput && promptText) {
        promptInput.value = promptText;
        promptInput.style.height = 'auto';
        promptInput.style.height = promptInput.scrollHeight + 'px';
    }
    
    // 滚动到输入框并聚焦
    promptInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    promptInput.focus();
    
    showToast('已复用提示词到输入框');
}

function createResultCard(imgSrc, promptText, elapsed = '', modelName = '', files = null, aspectRatio = '', imageSize = '', historyId = null) {
    const card = document.createElement('div');
    card.className = 'result-card';
    const timeStr = new Date().toLocaleTimeString();
    const fileName = `banana-ai-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.png`;
    const cardId = `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const elapsedDisplay = elapsed ? `<span style="margin-left: 8px; color: var(--text-secondary);"><i class="fas fa-clock"></i> ${elapsed}</span>` : '';
    const modelDisplay = modelName ? `<span style="margin-left: 8px; color: var(--primary);"><i class="fas fa-microchip"></i> ${modelName}</span>` : '';

    // 存储文件信息到卡片
    card.id = cardId;
    card.dataset.model = modelName || '';
    card.dataset.aspectRatio = aspectRatio || '';
    card.dataset.imageSize = imageSize || '';
    card.dataset.imgSrc = imgSrc; // 存储生成的图片地址
    card.dataset.prompt = promptText || '';
    if (historyId) {
        card.dataset.historyId = historyId;
    }
    if (files && files.length > 0) {
        setCardFiles(cardId, files);
    }

    // 如果有参考图片，显示缩略图
    let thumbsHtml = '';
    let compareBtnHtml = '';
    if (files && files.length > 0) {
        const imageFiles = files.filter(f => f.type && f.type.startsWith('image/'));
        if (imageFiles.length > 0) {
            thumbsHtml = `
                <div style="display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap;">
                    ${imageFiles.map((file, index) => `
                        <div class="thumb-item" style="position: relative; width: 50px; height: 50px; cursor: zoom-in;" onclick="previewImageByFile(${index}, '${cardId}')">
                            <img id="${cardId}-img-${index}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 6px; border: 1px solid var(--border);">
                        </div>
                    `).join('')}
                    <span style="font-size: 11px; color: var(--text-sub); align-self: center;">参考图</span>
                </div>
            `;
            // 添加图像对比按钮
            compareBtnHtml = `
                <button class="btn-secondary" onclick="openCompareModal('${cardId}')">
                    <i class="fas fa-columns"></i> 图像对比
                </button>
            `;
            
            // 异步加载图片预览 - 确保卡片已插入 DOM 后再加载
            // 使用 setTimeout 0 确保在下一个事件循环中卡片已插入
            const loadThumbnails = () => {
                // 再次检查卡片是否已插入 DOM
                const testEl = document.getElementById(`${cardId}-img-0`);
                if (!testEl) {
                    // 卡片还未插入，等待一下
                    setTimeout(loadThumbnails, 100);
                    return;
                }
                imageFiles.forEach((file, index) => {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const imgEl = document.getElementById(`${cardId}-img-${index}`);
                        if (imgEl) {
                            imgEl.src = e.target.result;
                        }
                    };
                    reader.readAsDataURL(file);
                });
            };
            setTimeout(loadThumbnails, 0);
        }
    }

    card.innerHTML = `
        <div class="result-header">
            <span class="result-prompt">提示词: ${escapeHTML(promptText || '')}</span>
            <span>${timeStr}${elapsedDisplay}${modelDisplay}</span>
        </div>
        ${thumbsHtml}
        <img src="${escapeAttr(getSafeImageSrc(imgSrc, 320, 240))}" class="result-img" alt="Generated Image"
             loading="lazy"
             decoding="async"
             onclick="openPreviewFromUrl(this.src, this.dataset.prompt || '')"
             data-prompt="${escapeAttr(promptText || '')}"
             style="cursor: zoom-in;"
             onerror="handleImageLoadError(this)">
        <div class="img-error-placeholder" style="display: none; flex-direction: column; align-items: center; justify-content: center; min-height: 200px; background: var(--bg-hover); border-radius: 8px; padding: 20px; text-align: center;">
            <i class="fas fa-exclamation-triangle" style="font-size: 48px; color: #ef4444; margin-bottom: 15px;"></i>
            <p style="color: var(--text-sub); margin-bottom: 10px;">图片加载失败</p>
        </div>
        <div class="action-bar">
            ${compareBtnHtml}
            <button class="btn-secondary" onclick="reuseImageGeneration('${escapeAttr(cardId)}')">
                <i class="fas fa-redo"></i> 复用
            </button>
            <button class="btn-secondary" onclick="copyResultPromptById('${escapeAttr(cardId)}')">
                <i class="fas fa-copy"></i> 复制提示词
            </button>
            <a href="${escapeAttr(imgSrc)}" download="${escapeAttr(fileName)}" class="btn-secondary" onclick="forceDownload(event, this.href, this.download)">
                <i class="fas fa-download"></i> 下载原图
            </a>
            <button class="btn-secondary" onclick="deleteResultCard(this)" style="background: var(--bg-error-light); color: var(--text-error); border-color: var(--border-error);">
                <i class="fas fa-trash"></i> 删除
            </button>
        </div>
    `;
    
    if (cardObserver) cardObserver.observe(card);
    return card;
}

function copyResultPromptById(cardId) {
    const card = document.getElementById(cardId);
    const promptText = card?.dataset?.prompt || '';
    copyText(promptText);
}

function createTextResultCard(text, promptText, fileName, files, elapsed = '', modelName = '') {
    const card = document.createElement('div');
    card.className = 'result-card';
    const timeStr = new Date().toLocaleTimeString();
    const cardId = `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const elapsedDisplay = elapsed ? `<span style="margin-left: 8px; color: var(--text-secondary);"><i class="fas fa-clock"></i> ${elapsed}</span>` : '';
    const modelDisplay = modelName ? `<span style="margin-left: 8px; color: var(--primary);"><i class="fas fa-microchip"></i> ${modelName}</span>` : '';

    let imagesHtml = '';
    if (files && files.length > 0) {
        const imageFiles = files.filter(f => f.type && f.type.startsWith('image/'));
        if (imageFiles.length > 0) {
            imagesHtml = `
                <div style="display: flex; gap: 10px; margin-bottom: 10px; flex-wrap: wrap;">
                    ${imageFiles.map((file, index) => `
                        <div class="thumb-item" style="position: relative; width: 80px; height: 80px; cursor: zoom-in;" onclick="previewImageByFile(${index}, '${cardId}')">
                            <img id="${cardId}-img-${index}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px; border: 1px solid var(--border);">
                        </div>
                    `).join('')}
                </div>
            `;

            // 异步加载缩略图 - 使用 requestIdleCallback 避免阻塞
            const loadThumbnails = () => {
                // 检查卡片是否已插入 DOM
                const testEl = document.getElementById(`${cardId}-img-0`);
                if (!testEl) {
                    setTimeout(loadThumbnails, 100);
                    return;
                }
                imageFiles.forEach((file, index) => {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const imgEl = document.getElementById(`${cardId}-img-${index}`);
                        if (imgEl) {
                            imgEl.src = e.target.result;
                        }
                    };
                    reader.readAsDataURL(file);
                });
            };
            setTimeout(loadThumbnails, 0);
        }
    }

    card.dataset.files = JSON.stringify((files || []).map(f => ({
        name: f.name,
        type: f.type,
        size: f.size
    })));
    card.dataset.prompt = promptText || '';
    card.dataset.result = text; // 存储结果文本到数据属性

    card.innerHTML = `
        <div class="result-header">
            <div style="display: flex; align-items: center; gap: 8px;">
                <span class="mode-badge recognition"><i class="fas fa-eye"></i> 图片反推</span>
                <span style="font-size: 12px; color: var(--text-sub);">${fileName}</span>
            </div>
            <span>${timeStr}${elapsedDisplay}${modelDisplay}</span>
        </div>
        ${imagesHtml}
        ${promptText ? `<div style="margin-bottom: 10px; font-size: 13px; color: var(--text-sub);"><strong>问题:</strong> ${escapeHTML(promptText)}</div>` : ''}
        <div style="padding: 15px; background: var(--bg-input); border-radius: 8px; border: 1px solid var(--border); max-height: 500px; overflow-y: auto; line-height: 1.6; font-size: 14px; white-space: pre-wrap;">${escapeHTML(text)}</div>
        <div class="action-bar">
            <button class="btn-secondary" onclick="reuseMediaRecognition('${cardId}')">
                <i class="fas fa-redo"></i> 复用
            </button>
            <button class="btn-secondary" onclick="copyCardResult('${cardId}')">
                <i class="fas fa-copy"></i> 复制结果
            </button>
        </div>
    `;
    card.id = cardId;
    setCardFiles(cardId, files);
    
    if (cardObserver) cardObserver.observe(card);
    return card;
}

// 复制卡片中的结果文本
function copyCardResult(cardId) {
    const card = document.getElementById(cardId);
    if (card && card.dataset.result) {
        copyText(card.dataset.result);
    }
}

function previewImageByFile(index, cardId) {
    const files = getCardFiles(cardId);
    if (files && files[index]) {
        const reader = new FileReader();
        reader.onload = (e) => {
            openPreviewFromUrl(e.target.result, '参考图片');
        };
        reader.readAsDataURL(files[index]);
    }
}

// 复用图片生成的提示词和参考图
function reuseImageGeneration(cardId) {
    const files = getCardFiles(cardId);
    const card = document.getElementById(cardId);
    
    // 从卡片中获取提示词
    let prompt = '';
    let modelName = '';
    let aspectRatio = '';
    let imageSize = '';
    if (card) {
        const promptEl = card.querySelector('.result-prompt');
        if (promptEl) {
            // 提示词格式是 "提示词: xxx"，需要去掉前缀
            const fullText = promptEl.textContent || '';
            prompt = fullText.replace(/^提示词:\s*/, '');
        }
        // 获取模型名称
        modelName = card.dataset.model || '';
        // 获取比例和像素
        aspectRatio = card.dataset.aspectRatio || '';
        imageSize = card.dataset.imageSize || '';
    }

    // 清空当前上传的文件
    uploadedFiles = [];

    // 复用参考图片
    if (files && files.length > 0) {
        uploadedFiles = [...files];
    }
    
    // 无论有没有图片，都要更新预览区域（清除旧图片）
    renderPreviews();

    // 设置提示词
    const promptInput = document.getElementById('prompt');
    if (promptInput && prompt) {
        promptInput.value = prompt;
        promptInput.style.height = 'auto';
        promptInput.style.height = promptInput.scrollHeight + 'px';
    }

    // 确保是图片生成模式
    const modeSelect = document.getElementById('modeSelect');
    if (modeSelect && modeSelect.value !== 'image-generation') {
        modeSelect.value = 'image-generation';
        updateMode();
    }

    // 复用模型选择
    if (modelName) {
        const modelSelect = document.getElementById('modelSelect');
        if (modelSelect) {
            modelSelect.value = modelName;
            updatePriceDisplay(modelName);
        }
    }

    // 复用比例选择
    if (aspectRatio) {
        const aspectRatioSelect = document.getElementById('aspectRatio');
        if (aspectRatioSelect) {
            aspectRatioSelect.value = aspectRatio;
        }
    }

    // 复用像素选择
    if (imageSize) {
        const imageSizeSelect = document.getElementById('imageSizeSelect');
        if (imageSizeSelect) {
            imageSizeSelect.value = imageSize;
        }
    }

    // 滚动到输入框并聚焦
    promptInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    promptInput.focus();
    
    showToast('已复用提示词、参考图、模型、比例和像素');
}

function reuseMediaRecognition(cardId) {
    const files = getCardFiles(cardId);
    const card = document.getElementById(cardId);
    const prompt = card ? card.dataset.prompt : '';

    uploadedFiles = [];

    if (files && files.length > 0) {
        uploadedFiles = [...files];
        renderPreviews();
    }

    const promptInput = document.getElementById('prompt');
    if (promptInput && prompt) {
        promptInput.value = prompt;
        promptInput.style.height = 'auto';
        promptInput.style.height = promptInput.scrollHeight + 'px';
    }

    const modeSelect = document.getElementById('modeSelect');
    if (modeSelect && modeSelect.value !== 'media-recognition') {
        modeSelect.value = 'media-recognition';
        updateMode();
    }

    promptInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    promptInput.focus();
}

function copyText(text) {
    navigator.clipboard.writeText(text).then(() => {
        // 使用更友好的提示方式，不使用alert
        showToast('已复制到剪贴板');
    }).catch(err => {
        console.error('复制失败:', err);
        showToast('复制失败，请手动复制', 'error');
    });
}

// 显示提示信息
function showToast(message, type = 'success') {
    // 移除已有的toast
    const existingToast = document.querySelector('.toast-message');
    if (existingToast) {
        existingToast.remove();
    }
    
    const toastBg = type === 'error' ? '#ef4444' : (type === 'warning' ? '#f59e0b' : 'var(--primary)');
    const toast = document.createElement('div');
    toast.className = 'toast-message';
    toast.style.cssText = `
        position: fixed;
        top: 80px;
        left: 50%;
        transform: translateX(-50%);
        background: ${toastBg};
        color: white;
        padding: 10px 20px;
        border-radius: 8px;
        font-size: 14px;
        z-index: 9999;
        animation: fadeInOut 2s forwards;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // 2秒后自动消失
    setTimeout(() => {
        toast.remove();
    }, 2000);
}

const TASK_RESULT_NOTIFICATIONS_KEY = 'banana_task_result_notifications_v1';

function loadTaskResultNotifications() {
    try {
        const parsed = JSON.parse(localStorage.getItem(TASK_RESULT_NOTIFICATIONS_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function saveTaskResultNotifications(notifications) {
    localStorage.setItem(TASK_RESULT_NOTIFICATIONS_KEY, JSON.stringify(notifications || []));
}

async function readHistoryItemById(itemId) {
    if (StorageAdapter.isServer()) {
        try {
            const item = await getHistoryItemById(itemId);
            if (item) return item;
            throw new Error('history item not found on server');
        } catch (e) {
            throw e;
        }
    }

    return new Promise((resolve, reject) => {
        if (!db || !itemId) {
            reject(new Error('history db not ready'));
            return;
        }
        try {
            const tx = db.transaction([STORE_NAME], 'readonly');
            const req = tx.objectStore(STORE_NAME).get(Number(itemId));
            req.onsuccess = (e) => resolve(e.target.result || null);
            req.onerror = () => reject(new Error('read history failed'));
        } catch (err) {
            reject(err);
        }
    });
}

function switchToRegularPage() {
    if (typeof window.switchPage === 'function') {
        window.switchPage('regular');
        return;
    }
    const regularBtn = document.getElementById('pageTabRegular');
    if (regularBtn) regularBtn.click();
}

function renderSuiteFailedSlot(card, errorMsg) {
    if (!card) return;
    card.classList.remove('suite-view-text');
    card.classList.add('suite-view-image');
    card.querySelectorAll('.suite-tab-btn').forEach(btn => btn.classList.remove('active'));
    const imgBtn = card.querySelector('.suite-tab-image');
    if (imgBtn) imgBtn.classList.add('active');
    const imageSlot = card.querySelector('.suite-image-slot');
    if (!imageSlot) return;
    imageSlot.innerHTML = `
        <div style="width:100%;height:100%;min-width:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:18px;border-radius:10px;background:linear-gradient(165deg,rgba(220,244,255,.92) 0%,rgba(195,235,252,.9) 34%,rgba(202,214,255,.9) 58%,rgba(198,174,255,.88) 100%);box-sizing:border-box;">
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;max-width:260px;margin:auto;">
                <div style="position:relative;width:clamp(72px,34%,142px);aspect-ratio:1;border:clamp(5px,1.5vw,8px) solid #fff;border-radius:50%;margin-bottom:clamp(14px,4%,24px);box-sizing:border-box;">
                    <span style="position:absolute;left:50%;top:50%;width:50%;height:clamp(5px,1vw,8px);background:#ef4444;border-radius:999px;transform:translate(-50%,-50%) rotate(45deg);"></span>
                    <span style="position:absolute;left:50%;top:50%;width:50%;height:clamp(5px,1vw,8px);background:#ef4444;border-radius:999px;transform:translate(-50%,-50%) rotate(-45deg);"></span>
                </div>
                <div style="font-weight:800;font-size:clamp(18px,5vw,30px);line-height:1.15;color:#111827;margin-bottom:clamp(8px,2.8%,14px);">图像生成失败</div>
                <div style="font-size:clamp(12px,3.3vw,16px);line-height:1.45;color:#1f2937;max-width:92%;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${escapeHTML(errorMsg || '未知错误')}</div>
            </div>
        </div>
    `;
}

function normalizeTaskResultNotification(input) {
    const createdAt = input.createdAt || Date.now();
    const stage = input.stage || 'task';
    const taskType = input.taskType || 'regular';
    const status = input.status || 'success';
    const key = input.historyId || input.taskId || createdAt;
    return {
        id: input.id || `${taskType}_${stage}_${key}_${createdAt}`,
        historyId: input.historyId || null,
        taskId: input.taskId || null,
        cardId: input.cardId || '',
        taskType,
        stage,
        status,
        title: input.title || '任务已完成',
        message: input.message || '',
        successCount: Number.isFinite(input.successCount) ? input.successCount : null,
        failCount: Number.isFinite(input.failCount) ? input.failCount : null,
        totalCount: Number.isFinite(input.totalCount) ? input.totalCount : null,
        createdAt
    };
}

function addTaskResultNotification(input) {
    const next = normalizeTaskResultNotification(input || {});
    let notifications = loadTaskResultNotifications().filter(item => {
        if (next.historyId && item.historyId && String(item.historyId) === String(next.historyId) && item.stage === next.stage) return false;
        if (next.taskId && item.taskId && String(item.taskId) === String(next.taskId) && item.stage === next.stage) return false;
        return item.id !== next.id;
    });
    notifications.unshift(next);
    saveTaskResultNotifications(notifications);
    renderTaskResultNotifications();
    return next.id;
}

function dismissTaskResultNotification(id) {
    const notifications = loadTaskResultNotifications().filter(item => item.id !== id);
    saveTaskResultNotifications(notifications);
    renderTaskResultNotifications();
}

function formatTaskResultTime(timestamp) {
    const date = new Date(timestamp || Date.now());
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function focusTaskResultCard(cardId) {
    const card = cardId ? document.getElementById(cardId) : null;
    if (!card) return false;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prevOutline = card.style.outline;
    const prevOutlineOffset = card.style.outlineOffset;
    card.style.outline = '2px solid var(--primary)';
    card.style.outlineOffset = '3px';
    setTimeout(() => {
        card.style.outline = prevOutline;
        card.style.outlineOffset = prevOutlineOffset;
    }, 2200);
    return true;
}

function openTaskResultNotification(id) {
    const notification = loadTaskResultNotifications().find(item => item.id === id);
    if (!notification) return;
    dismissTaskResultNotification(id);

    if (notification.taskType === 'suite' && notification.historyId && typeof window.restoreSuiteFromHistory === 'function') {
        window.restoreSuiteFromHistory(notification.historyId);
        return;
    }

    if (notification.taskType !== 'suite') {
        switchToRegularPage();
    }

    if (focusTaskResultCard(notification.cardId)) return;

    if (notification.historyId && db) {
        try {
            const tx = db.transaction([STORE_NAME], 'readonly');
            const req = tx.objectStore(STORE_NAME).get(Number(notification.historyId));
            req.onsuccess = (e) => {
                const item = e.target.result;
                if (!item) {
                    showToast('未找到对应历史记录', 'error');
                    return;
                }
                if (item.type === 'suite' && typeof window.restoreSuiteFromHistory === 'function') {
                    window.restoreSuiteFromHistory(item.id);
                } else if (item.type === 'image' && item.image) {
                    openModal(item);
                } else {
                    reuseHistoryItemById(item.id);
                }
            };
            req.onerror = () => showToast('历史记录读取失败', 'error');
            return;
        } catch (e) {
            showToast('历史记录读取失败', 'error');
            return;
        }
    }

    showToast('该任务结果不在当前页面，请到历史记录中查看', 'error');
}

function renderTaskResultNotifications() {
    const notifications = loadTaskResultNotifications();
    let container = document.getElementById('taskResultNotificationCenter');
    if (notifications.length === 0) {
        if (container) container.remove();
        return;
    }
    if (!container) {
        container = document.createElement('div');
        container.id = 'taskResultNotificationCenter';
        document.body.appendChild(container);
    }

    container.style.cssText = `
        position: fixed;
        top: 76px;
        right: 18px;
        width: min(360px, calc(100vw - 36px));
        z-index: 9998;
        display: flex;
        flex-direction: column;
        gap: 10px;
        pointer-events: none;
    `;

    container.innerHTML = notifications.map(item => {
        const color = item.status === 'failed' ? '#ef4444' : (item.status === 'partial' ? '#f59e0b' : '#10b981');
        const icon = item.status === 'failed' ? 'fa-circle-xmark' : (item.status === 'partial' ? 'fa-circle-exclamation' : 'fa-circle-check');
        const subtitle = item.message || (item.status === 'failed' ? '任务失败' : '任务完成');
        return `
            <div class="task-result-notification" style="pointer-events:auto;background:var(--bg-card);border:1px solid var(--border);border-left:4px solid ${color};box-shadow:0 10px 28px rgba(0,0,0,0.18);border-radius:12px;padding:12px;">
                <div style="display:flex;gap:10px;align-items:flex-start;">
                    <i class="fas ${icon}" style="color:${color};font-size:18px;margin-top:2px;"></i>
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
                            <strong style="font-size:14px;color:var(--text-main);">${escapeHTML(item.title)}</strong>
                            <span style="font-size:11px;color:var(--text-sub);white-space:nowrap;">${formatTaskResultTime(item.createdAt)}</span>
                        </div>
                        <div style="font-size:12px;color:var(--text-sub);margin-top:4px;line-height:1.4;">${escapeHTML(subtitle)}</div>
                        <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;">
                            <button type="button" data-notification-dismiss="${escapeHTML(item.id)}" class="btn-secondary" style="padding:5px 10px;font-size:12px;border-radius:8px;">知道了</button>
                            <button type="button" data-notification-view="${escapeHTML(item.id)}" style="padding:5px 10px;font-size:12px;border-radius:8px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer;">查看</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('[data-notification-dismiss]').forEach(btn => {
        btn.onclick = () => dismissTaskResultNotification(btn.dataset.notificationDismiss);
    });
    container.querySelectorAll('[data-notification-view]').forEach(btn => {
        btn.onclick = () => openTaskResultNotification(btn.dataset.notificationView);
    });
}

window.__addTaskResultNotification = addTaskResultNotification;

function clearPageList() {
    if (!confirm('确定要清空所有数据吗？\n\n将清除：\n• 全部历史记录（含图片）\n• 全部对话记录\n• 图片缓存\n\n此操作不可恢复！')) return;

    const tasks = [];

    // 1. 清空 IndexedDB 历史记录表
    if (db) {
        tasks.push(new Promise((resolve) => {
            try {
                const tx = db.transaction([STORE_NAME], 'readwrite');
                tx.objectStore(STORE_NAME).clear();
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            } catch (_) { resolve(); }
        }));
        // 2. 清空 IndexedDB 对话表
        tasks.push(new Promise((resolve) => {
            try {
                const tx = db.transaction([CHAT_STORE_NAME], 'readwrite');
                tx.objectStore(CHAT_STORE_NAME).clear();
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            } catch (_) { resolve(); }
        }));
    }

    // 3. 清空图片缓存数据库
    tasks.push(new Promise((resolve) => {
        try {
            const req = indexedDB.open(IMAGE_CACHE_DB_NAME, IMAGE_CACHE_DB_VERSION);
            req.onsuccess = (e) => {
                const cacheDb = e.target.result;
                const tx = cacheDb.transaction([CHAT_IMAGE_CACHE_STORE], 'readwrite');
                tx.objectStore(CHAT_IMAGE_CACHE_STORE).clear();
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            };
            req.onerror = resolve;
        } catch (_) { resolve(); }
    }));

    // 4. 清空 localStorage 对话数据和通知
    try { localStorage.removeItem(CHAT_LOCALSTORAGE_KEY); } catch (_) {}
    try { localStorage.removeItem(TASK_RESULT_NOTIFICATIONS_KEY); } catch (_) {}

    Promise.all(tasks).then(() => {
        // 清空 API 图片缓存
        _apiImageCache.clear();
        showToast('所有数据已清空，页面即将刷新');
        // 刷新页面以重置所有状态，避免手动重置遗漏导致页面异常
        setTimeout(() => location.reload(), 800);
    });
}

function toggleHistoryDrawer() {
    const drawer = document.getElementById('historyDrawer');
    const overlay = document.getElementById('drawerOverlay');
    const isOpen = drawer.classList.contains('open');
    
    drawer.classList.toggle('open');
    overlay.classList.toggle('open');
    
    // 如果是打开抽屉，秒级拉取最新数据，防止时序空档
    if (!isOpen) {
        loadHistoryToSidebar();
    }
}

// 创建历史记录卡片 DOM（不添加到页面，用于批量创建）
function createHistoryThumbnail(item) {
    const div = document.createElement('div');
    div.className = 'history-item';
    const itemId = item.id;

    const isRecognition = item.type === 'recognition';
    const isSuite = item.type === 'suite';

    const maxPromptLength = 100;
    const rawPrompt = isSuite
        ? (item.rule || item.prompt || '')
        : (item.prompt || '');
    const displayPrompt = rawPrompt.length > maxPromptLength
        ? rawPrompt.substring(0, maxPromptLength) + '...'
        : rawPrompt;
    const promptTitle = isSuite ? '' : escapeHTML(item.prompt || '');

    // 套图显示第一张上传图，反推显示结果图或第一张上传图（减少存储压力）
    const suiteArchivedThumb = isSuite && item.archiveStatus === 'archived' && Array.isArray(item.images)
        ? item.images.slice().sort((a, b) => (a.index || 0) - (b.index || 0)).map(img => getSuiteArchiveCachedImageUrl(img)).find(Boolean)
        : '';
    const suiteFallbackThumb = item.archiveStatus === 'archived'
        ? (item.firstImage && !String(item.firstImage).startsWith('http') ? item.firstImage : item.fileData?.[0]?.data)
        : (item.firstImage || item.thumbnail || item.fileData?.[0]?.data);
    const imgSrc = isSuite
        ? (suiteArchivedThumb || suiteFallbackThumb || item.thumbnail || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect fill="%23e5e7eb" width="80" height="80"/><text x="40" y="45" text-anchor="middle" fill="%236b7280" font-size="30">📷</text></svg>'))
        : (item.url || item.thumbnail || item.image || (isRecognition ? 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect fill="%23e5e7eb" width="80" height="80"/><text x="40" y="45" text-anchor="middle" fill="%236b7280" font-size="30">📝</text></svg>') : ''));

    const typeBadge = isRecognition
        ? '<span style="position: absolute; top: 5px; left: 5px; background: linear-gradient(135deg, #10b981, #059669); color: white; font-size: 10px; padding: 2px 6px; border-radius: 3px;"><i class="fas fa-eye"></i> 反推</span>'
        : (isSuite ? '<span style="position: absolute; top: 5px; left: 5px; background: linear-gradient(135deg, #f59e0b, #d97706); color: white; font-size: 10px; padding: 2px 6px; border-radius: 3px;"><i class="fas fa-layer-group"></i> 套图</span>' : '');
    const archiveCodeText = item.archiveCode || '已归档';
    const archiveCodeMatch = String(archiveCodeText).match(/^(.+?)(-\d+)$/);
    const archiveBadge = isSuite && item.archiveStatus === 'archived'
        ? `<span class="history-archive-badge"><span>${escapeHTML(archiveCodeMatch ? archiveCodeMatch[1] : archiveCodeText)}</span>${archiveCodeMatch ? `<span>${escapeHTML(archiveCodeMatch[2])}</span>` : ''}</span>`
        : '';
    const archiveThumbButton = isSuite
        ? `<button class="history-thumb-archive-btn" onclick="event.stopPropagation(); archiveSuiteHistoryItem(${itemId})">
                <i class="fas fa-box-archive"></i> ${item.archiveStatus === 'archived' ? '重归档' : '归档'}
            </button>`
        : '';
    
    // 存储结果到data属性
    if (item.result) {
        div.dataset.result = item.result;
    }
    
    // 自动提取本地磁盘文件名，用于悬浮 title 属性提示
    let localFilename = '';
    if (item.url && typeof item.url === 'string') {
        try {
            const decodedUrl = decodeURIComponent(item.url);
            const parts = decodedUrl.split('/');
            const filenameWithExt = parts[parts.length - 1];
            if (filenameWithExt) {
                const lastDot = filenameWithExt.lastIndexOf('.');
                localFilename = lastDot !== -1 ? filenameWithExt.substring(0, lastDot) : filenameWithExt;
            }
        } catch (_) {}
    }

    // 智能渲染悬浮磁盘位置信息
    let titleTip = '';
    if (isSuite) {
        if (item.localFolderName) {
            titleTip = `套图物理磁盘目录:\nLoirs_Data/output/套图/${item.localFolderName}`;
        } else {
            titleTip = '套图模式（尚无子插槽图片生成落盘）';
        }
    } else if (item.mode === 'chat' || item.chatName) {
        const chatFolderName = item.chatName || '未命名对话';
        if (localFilename) {
            titleTip = `对话磁盘物理文件:\nLoirs_Data/output/对话/${chatFolderName}/${localFilename}.png`;
        } else {
            titleTip = `对话模式 (${chatFolderName})`;
        }
    } else {
        if (localFilename) {
            titleTip = `常规磁盘物理文件:\nLoirs_Data/output/常规/${localFilename}.png`;
        } else {
            titleTip = item.prompt || '暂无物理磁盘文件名';
        }
    }
    
    let metaInfoHtml = '';
    if (!isRecognition && (item.type === 'image' || item.image || item.url)) {
        const ratioText = item.aspectRatio || item.ratio || '';
        
        let targetResText = '';
        if (item.targetResolution && item.targetResolution.width && item.targetResolution.height) {
            targetResText = `${item.targetResolution.width}×${item.targetResolution.height}`;
        } else if (item.width && item.height) {
            targetResText = `${item.width}×${item.height}`;
        }
        
        const modelText = item.model || '';
        
        let actualResText = '';
        if (item.actualResolution && item.actualResolution.width && item.actualResolution.height) {
            actualResText = `${item.actualResolution.width}×${item.actualResolution.height}`;
        }
        
        metaInfoHtml = `
            <div class="history-item-meta">
                <div class="history-meta-row">
                    ${ratioText ? `<span class="history-meta-item"><i class="fas fa-crop-alt"></i> ${ratioText}</span>` : ''}
                    ${targetResText ? `<span class="history-meta-item"><i class="fas fa-expand-arrows-alt"></i> ${targetResText}</span>` : ''}
                </div>
                ${modelText ? `<div class="history-meta-row"><span class="history-meta-item"><i class="fas fa-microchip"></i> ${modelText}</span></div>` : ''}
                ${actualResText ? `<div class="history-meta-actual"><i class="fas fa-image"></i> ${actualResText}</div>` : ''}
            </div>
        `;
    }

    div.innerHTML = `
        <div class="history-thumb-column">
            <div class="history-thumb-frame" onclick="event.stopPropagation(); ${isSuite ? `restoreSuiteFromHistory(${itemId})` : `openHistoryModal(${itemId})`}" style="cursor: pointer;" title="${escapeAttr(titleTip)}">
                <img src="${escapeAttr(getSafeImageSrc(imgSrc, 80, 80))}" class="history-item-img" loading="lazy" onerror="handleImageLoadError(this)">
                ${typeBadge}
                ${archiveBadge}
            </div>
            ${archiveThumbButton}
        </div>
        <div class="history-item-content">
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                <span class="history-item-prompt" title="${promptTitle}" style="flex: 1; min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${escapeHTML(displayPrompt)}</span>
                <label onclick="event.stopPropagation()" style="display: inline-flex; align-items: center; gap: 4px; cursor: pointer;">
                    <input type="checkbox" class="history-checkbox" data-id="${itemId}" onclick="toggleHistoryCheckbox(this)" style="width: 18px; height: 18px; cursor: pointer; accent-color: var(--primary);">
                </label>
            </div>
            ${metaInfoHtml}
            <div class="history-item-actions">
                <div class="history-item-actions-row">
                    <button onclick="event.stopPropagation(); reuseHistoryItemById(${itemId})">
                        <i class="fas fa-redo"></i> 复用
                    </button>
                    ${isSuite ? `<button onclick="event.stopPropagation(); restoreSuiteFromHistory(${itemId})" style="background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; border-color: #7c3aed;">
                        <i class="fas fa-eye"></i> 查看
                    </button>
                    <button onclick="event.stopPropagation(); copyHistoryRuleById(${itemId})">
                        <i class="fas fa-copy"></i> 复制关键词
                    </button>` : `
                    <button onclick="event.stopPropagation(); copyHistoryPromptById(${itemId})">
                        <i class="fas fa-copy"></i> 复制提示词
                    </button>`}
                    ${isRecognition && item.result ? `<button onclick="event.stopPropagation(); copyHistoryResult(this)">
                        <i class="fas fa-file-alt"></i> 复制结果
                    </button>` : ''}
                    ${item.type === 'image' ? `<button onclick="event.stopPropagation(); openHistoryModal(${itemId})" style="background: var(--primary); color: white; border-color: var(--primary);">
                        <i class="fas fa-expand"></i> 查看
                    </button>` : ''}
                    <button onclick="event.stopPropagation(); deleteFromDB(${itemId}, this.closest('.history-item'))" style="background: var(--bg-error-light); color: var(--text-error); border-color: var(--border-error);">
                        <i class="fas fa-trash"></i> 删除
                    </button>
                </div>
            </div>
        </div>
    `;
    
    // 点击卡片内容区域打开预览或复用
    div.querySelector('.history-item-content').addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON' && !e.target.closest('button')) {
            if (item.type === 'image') {
                openHistoryModal(item.id);
            } else {
                reuseHistoryItemById(item.id);
            }
        }
    });
    
    return div;
}

// 切换历史记录选中状态
let selectedHistoryIds = new Set();

function toggleHistoryCheckbox(checkbox) {
    const id = parseInt(checkbox.dataset.id);
    if (checkbox.checked) {
        selectedHistoryIds.add(id);
    } else {
        selectedHistoryIds.delete(id);
    }
    updateSelectedCount();
}

function updateSelectedCount() {
    const count = selectedHistoryIds.size;
    const btn = document.getElementById('deleteSelectedBtn');
    const countSpan = document.getElementById('selectedCount');
    if (btn) {
        btn.style.display = count > 0 ? 'inline-flex' : 'none';
    }
    if (countSpan) {
        countSpan.textContent = count;
    }
}

// 删除选中的历史记录
async function deleteSelectedHistory() {
    if (selectedHistoryIds.size === 0) {
        showToast('请先选择要删除的记录');
        return;
    }
    if (!confirm(`确定删除选中的 ${selectedHistoryIds.size} 条记录吗？`)) return;
    
    const deletePromises = [];
    selectedHistoryIds.forEach(id => {
        if (StorageAdapter.isServer()) {
            deletePromises.push(
                fetch(`/api/history?id=${id}`, { method: 'DELETE' })
                    .then(res => res.json())
                    .catch(e => console.error('⚠️ 批量删除本地物理文件失败:', id, e))
            );
        }
        
        // 从内存中移除
        const index = historyAllItems.findIndex(item => item.id === id);
        if (index !== -1) {
            historyAllItems.splice(index, 1);
        }
        // 从 DOM 移除
        const el = document.querySelector(`.history-checkbox[data-id="${id}"]`)?.closest('.history-item');
        if (el) {
            el.style.transition = 'opacity 0.3s, transform 0.3s';
            el.style.opacity = '0';
            el.style.transform = 'scale(0.8)';
            setTimeout(() => el.remove(), 300);
        }
    });

    if (StorageAdapter.isServer()) {
        await Promise.all(deletePromises);
        historyTotalPages = Math.ceil(historyAllItems.length / historyPageSize) || 1;
        if (historyCurrentPage > historyTotalPages) {
            historyCurrentPage = historyTotalPages;
        }
        selectedHistoryIds.clear();
        updateSelectedCount();
        showToast('已删除选中的记录');
        loadHistoryPage(historyCurrentPage);
        return;
    }
    
    if (!db) return;
    
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    
    selectedHistoryIds.forEach(id => {
        store.delete(id);
    });
    
    transaction.oncomplete = () => {
        historyTotalPages = Math.ceil(historyAllItems.length / historyPageSize) || 1;
        if (historyCurrentPage > historyTotalPages) {
            historyCurrentPage = historyTotalPages;
        }
        selectedHistoryIds.clear();
        updateSelectedCount();
        showToast('已删除选中的记录');
    };
}

// 添加单条历史记录到侧边栏
function addHistoryThumbnail(item, prepend = false) {
    const grid = document.getElementById('historyGrid');
    const div = createHistoryThumbnail(item);
    
    if (prepend) grid.prepend(div);
    else grid.appendChild(div);
}

async function copyHistoryFieldById(itemId, fieldName) {
    const lightItem = historyAllItems.find(item => Number(item.id) === Number(itemId));
    let value = lightItem?.[fieldName] || '';
    if (!value) {
        const fullItem = await getHistoryItemById(itemId);
        value = fullItem?.[fieldName] || '';
    }
    copyText(value);
}

function copyHistoryPromptById(itemId) {
    void copyHistoryFieldById(itemId, 'prompt');
}

function copyHistoryRuleById(itemId) {
    void copyHistoryFieldById(itemId, 'rule');
}
// 复制历史记录中的结果文本
function copyHistoryResult(btn) {
    const historyItem = btn.closest('.history-item');
    if (historyItem && historyItem.dataset.result) {
        copyText(historyItem.dataset.result);
    }
}

async function reuseHistoryItemById(itemId) {
    let item = null;
    if (StorageAdapter.isServer()) {
        item = await getHistoryItemById(itemId);
    } else if (db) {
        item = await new Promise(resolve => {
            try {
                const transaction = db.transaction([STORE_NAME], "readonly");
                const store = transaction.objectStore(STORE_NAME);
                const request = store.get(Number(itemId));
                request.onsuccess = (e) => resolve(e.target.result || null);
                request.onerror = () => resolve(null);
            } catch (_) { resolve(null); }
        });
    }

    if (!item) {
        alert('找不到该记录');
        return;
    }

    uploadedFiles = [];

    const promptInput = document.getElementById('prompt');
    if (promptInput && item.prompt) {
        promptInput.value = item.prompt;
        promptInput.style.height = 'auto';
        promptInput.style.height = promptInput.scrollHeight + 'px';
    }

    const modeSelect = document.getElementById('modeSelect');
    const isRecognition = item.type === 'recognition';

        if (modeSelect) {
            modeSelect.value = isRecognition ? 'media-recognition' : 'image-generation';
            updateMode();
        }

        // 恢复模型选择
        if (item.model) {
            const modelSelect = document.getElementById('modelSelect');
            if (modelSelect) {
                modelSelect.value = item.model;
                updateModelDropdownForMode(isRecognition ? 'media-recognition' : 'image-generation');
                updatePriceDisplay(item.model);
                
                // 更新下拉菜单选中状态
                document.querySelectorAll('.model-dropdown-item').forEach(el => {
                    el.classList.remove('selected');
                    if (el.textContent === item.model) {
                        el.classList.add('selected');
                    }
                });
            }
        }

        if (item.fileData && item.fileData.length > 0) {
            item.fileData.forEach(fileData => {
                const byteString = atob(fileData.data.split(',')[1]);
                const mimeString = fileData.data.split(',')[0].split(':')[1].split(';')[0];
                const ab = new ArrayBuffer(byteString.length);
                const ia = new Uint8Array(ab);
                for (let i = 0; i < byteString.length; i++) {
                    ia[i] = byteString.charCodeAt(i);
                }
                const blob = new Blob([ab], { type: mimeString });
                const file = new File([blob], fileData.name, { type: fileData.type });
                uploadedFiles.push(file);
            });
        }
        
        // 无论有没有图片，都要更新预览区域（清除旧图片）
        renderPreviews();

        // 恢复比例选择（仅图片生成模式）
        if (!isRecognition && item.aspectRatio) {
            const aspectRatioSelect = document.getElementById('aspectRatio');
            if (aspectRatioSelect) {
                aspectRatioSelect.value = item.aspectRatio;
            }
        }

        // 恢复像素选择（仅图片生成模式）
        if (!isRecognition && item.imageSize) {
            const imageSizeSelect = document.getElementById('imageSizeSelect');
            if (imageSizeSelect) {
                imageSizeSelect.value = item.imageSize;
            }
        }

        promptInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        promptInput.focus();
}

// 按需加载历史记录原图并打开放大镜（避免内存中常驻大图）
async function openHistoryModal(itemId) {
    const item = await getHistoryItemById(itemId);
    const imageUrl = item ? (item.image || item.url) : null;
    if (!item || !imageUrl) {
        showToast('无法加载图片');
        return;
    }
    openModal({ id: itemId, image: imageUrl, prompt: item.prompt || '' });
}

function openModal(item) {
    const imageUrl = item?.image || '';
    if (!imageUrl) return;
    openPreviewGallery([{
        src: imageUrl,
        prompt: item?.prompt || '',
        label: item?.id ? `历史记录 #${item.id}` : '图片'
    }], 0, item?.id ? `banana_history_${item.id}.png` : `banana_history_${Date.now()}.png`);
}

    // 恢复套图历史记录
    async function restoreSuiteFromHistory(itemId) {
        debugLog('🔍 restoreSuiteFromHistory 被调用, itemId:', itemId);
        debugLog('🔍 db 状态:', db ? '已初始化' : '未初始化');

        if (!db) {
            console.error('❌ 数据库未初始化');
            alert('数据库未初始化，请刷新页面重试');
            return;
        }

        const transaction = db.transaction([STORE_NAME], "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(Number(itemId));

        request.onsuccess = (e) => {
            const item = e.target.result;
            debugLog('🔍 查询结果:', item ? '找到记录' : '未找到记录');

            if (!item) {
                alert('找不到该记录');
                return;
            }

            if (item.type !== 'suite') {
                alert('该记录不是套图记录');
                return;
            }

            debugLog('🔍 开始恢复:', {
                keywords: item.keywords,
                imagesCount: item.images?.length,
                fileDataCount: item.fileData?.length,
                firstImage: item.firstImage?.substring(0, 50)
            });

            // 切换到套图模式
            switchPage('suite');

            // 恢复上传图片
            if (item.fileData && item.fileData.length > 0) {
                // 将 base64 数据转回 File 对象
                Promise.all(item.fileData.map((entry) => {
                    // entry 可能是字符串（旧格式）或 {data, name, type} 对象（新格式）
                    const raw = (entry && typeof entry === 'object') ? (entry.data || '') : String(entry || '');
                    const entryName = (entry && typeof entry === 'object') ? entry.name : null;
                    const matches = raw.match(/^data:([^;]+);base64,(.+)$/);
                    if (!matches) return null;
                    const mimeType = matches[1];
                    const base64Data = matches[2];
                    const binaryString = atob(base64Data);
                    const len = binaryString.length;
                    const bytes = new Uint8Array(len);
                    for (let i = 0; i < len; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    const blob = new Blob([bytes], { type: mimeType });
                    const fileName = entryName || `history_${Date.now()}.${mimeType.split('/')[1]}`;
                    return new File([blob], fileName, { type: mimeType });
                })).then(files => {
                    const validFiles = files.filter(f => f !== null);
                    if (validFiles.length > 0) {
                        window.suiteFiles = validFiles;
                        renderSuitePreviews();
                    }
                });
            }

            // 恢复输入框内容
            const copyInput = document.getElementById('suiteCopyInput');
            if (copyInput && item.rule) {
                copyInput.value = item.rule;
            }

            // 恢复 ratio 和 size
            if (item.ratio) {
                const ratioInput = document.getElementById('suiteRatioInput');
                if (ratioInput) {
                    ratioInput.value = item.ratio;
                    syncCustomSelectUI('suiteRatioInput', 'suiteRatioValue', 'suiteRatioMenu');
                }
            }
            if (item.size) {
                const sizeInput = document.getElementById('suiteSizeInput');
                if (sizeInput) {
                    sizeInput.value = item.size;
                    syncCustomSelectUI('suiteSizeInput', 'suiteSizeValue', 'suiteSizeMenu');
                }
            }

            // 恢复关键词到卡槽
            const countInput = document.getElementById('suiteCountInput');
            const keywords = Array.isArray(item.keywords) ? item.keywords : [];
            const suiteImages = Array.isArray(item.images)
                ? item.images.slice().sort((a, b) => (a.index || 0) - (b.index || 0))
                : [];
            debugLog('🔍 准备恢复关键词:', keywords, '图片数量:', suiteImages.length);

            if (countInput) {
                const cardCount = Math.max(keywords.length, suiteImages.reduce((max, img) => Math.max(max, img?.index || 0), 0), 4);
                countInput.value = Math.min(cardCount, 12);
                debugLog('🔍 创建', cardCount, '个卡槽');
                buildSlots();
            } else {
                console.error('❌ 未找到 suiteCountInput 元素');
            }

            // 等待卡槽创建完成后填入内容（增加等待时间到500ms确保DOM完成）
            setTimeout(async () => {
                const cards = document.querySelectorAll('.suite-card');
                const textareas = document.querySelectorAll('.suite-text-area');

                debugLog('🔍 setTimeout 回调执行:', {
                    keywords: keywords,
                    imagesCount: suiteImages.length || 0,
                    cardsCount: cards.length,
                    textareasCount: textareas.length,
                    firstImage: suiteImages?.[0]?.imageUrl?.substring(0, 50)
                });

                // 填入关键词，按卡槽 index 对应恢复
                let filledCount = 0;
                const keywordMap = new Map();
                keywords.forEach((keyword, idx) => keywordMap.set(idx + 1, keyword));
                suiteImages.forEach((img) => {
                    if (img?.index && !keywordMap.has(img.index) && img.keyword) {
                        keywordMap.set(img.index, img.keyword);
                    }
                });
                for (let i = 0; i < textareas.length; i++) {
                    const slotIndex = i + 1;
                    const keyword = keywordMap.get(slotIndex) || '';
                    if (textareas[i] && keyword) {
                        textareas[i].value = keyword;
                        filledCount++;
                    }
                }
                debugLog('✅ 填入', filledCount, '个关键词');

                // 恢复生成的图片（按 index 对应卡槽，默认优先显示图片视图）
                // 如果有图片数据，所有卡片都默认显示图片视图
                if (suiteImages.length > 0) {
                    let imgCount = 0;
                    let localArchiveMissCount = 0;
                    let grantedArchiveDirectoryHandle = null;
                    if (item.archiveStatus === 'archived' && suiteArchiveDirectoryHandle) {
                        let permission = await querySuiteArchiveDirectoryPermission(suiteArchiveDirectoryHandle);
                        if (permission !== 'granted') {
                            permission = await requestSuiteArchiveDirectoryPermission(suiteArchiveDirectoryHandle);
                        }
                        if (permission === 'granted') {
                            grantedArchiveDirectoryHandle = suiteArchiveDirectoryHandle;
                        } else {
                            debugWarn('归档目录未授权，无法读取本地归档图片:', {
                                permission,
                                archiveCode: item.archiveCode || '',
                                archiveFolderName: item.archiveFolderName || ''
                            });
                        }
                    }
                    const imageMap = new Map();
                    suiteImages.forEach((imgData) => {
                        const slotIndex = Number(imgData.index || 0);
                        if (slotIndex > 0 && (item.archiveStatus === 'archived' || imgData.imageUrl)) {
                            imageMap.set(slotIndex, imgData);
                        }
                    });

                    for (let i = 0; i < cards.length; i++) {
                        const slotIndex = i + 1;
                        const card = cards[i];
                        const imgData = imageMap.get(slotIndex);
                        
                        // 优先显示图片视图，无论该卡槽是否有图片
                        card.classList.remove('suite-view-text');
                        card.classList.add('suite-view-image');
                        card.querySelectorAll('.suite-tab-btn').forEach(b => b.classList.remove('active'));
                        const imgBtn = card.querySelector('.suite-tab-image');
                        if (imgBtn) imgBtn.classList.add('active');

                        let displayImageUrl = item.archiveStatus === 'archived' ? getSuiteArchiveCachedImageUrl(imgData) : '';
                        if (!displayImageUrl && item.archiveStatus === 'archived') {
                            displayImageUrl = await getSuiteArchiveSavedFileUrl(item, imgData, false, grantedArchiveDirectoryHandle);
                        }
                        if (!displayImageUrl && item.archiveStatus !== 'archived') displayImageUrl = imgData?.imageUrl || '';
                        if (card && displayImageUrl) {
                            renderSuiteImageIntoSlot(card, displayImageUrl, slotIndex, `卡槽 ${slotIndex} 图片`);
                            updateSuiteCardResolutionBySlot(slotIndex, displayImageUrl, imgData.actualSize || `${getTargetResolution(item.size || '1K', item.ratio || '1:1').width} x ${getTargetResolution(item.size || '1K', item.ratio || '1:1').height}`);
                            imgCount++;
                        } else if (item.archiveStatus === 'archived' && imgData) {
                            localArchiveMissCount++;
                        }
                    }
                    debugLog('✅ 恢复', imgCount, '张图片到卡槽');
                    if (item.archiveStatus === 'archived' && localArchiveMissCount > 0) {
                        debugWarn('归档记录未能从本地缓存/文件恢复全部图片:', {
                            archiveCode: item.archiveCode || '',
                            archiveFolderName: item.archiveFolderName || '',
                            missCount: localArchiveMissCount,
                            hasDirectoryHandle: !!suiteArchiveDirectoryHandle
                        });
                        showToast('归档图片未能从本地文件恢复，请确认归档目录授权正确', 'warning');
                    }
                } else {
                    debugLog('⚠️ 历史记录中没有图片数据');
                }
            }, 500);

            alert('套图已恢复');
        };

        request.onerror = () => {
            alert('恢复失败');
        };
    }

let currentModalGallery = [];
let currentModalIndex = 0;
let currentModalFileNamePrefix = 'banana_gen';

function normalizePreviewItem(item, fallbackLabel = '图片') {
    if (!item) return null;
    if (typeof item === 'string') {
        return { src: item, prompt: '', label: fallbackLabel };
    }
    const src = String(item.src || item.image || item.data || item.url || '').trim();
    if (!src) return null;
    return {
        src,
        prompt: String(item.prompt || item.keyword || '').trim(),
        label: String(item.label || fallbackLabel).trim() || fallbackLabel
    };
}

function renderModalGalleryItem(index) {
    const item = currentModalGallery[index];
    if (!item) return;

    currentModalIndex = index;

    const modal = document.getElementById('imageModal');
    const modalImg = document.getElementById('modalImg');
    const modalPrompt = document.getElementById('modalPrompt');
    const modalMeta = document.getElementById('modalMeta');
    const prevBtn = document.getElementById('modalPrevBtn');
    const nextBtn = document.getElementById('modalNextBtn');
    const dl = document.getElementById('modalDownload');

    modalImg.src = item.src;
    modalImg._cacheAttempted = false;
    modalImg.onerror = async function() {
        if (this._cacheAttempted) return;
        this._cacheAttempted = true;
        const cached = await getCachedChatImageFromDB(item.src);
        if (cached) {
            this.src = cached.original || cached.thumbnail || '';
            // 更新下载链接
            if (this.src) {
                dl.href = this.src;
                dl.onclick = (e) => forceDownload(e, this.src, fileName);
            }
        }
    };
    modalPrompt.textContent = item.prompt || item.label || '';
    modalMeta.textContent = currentModalGallery.length > 1
        ? `${item.label || '图片'} · ${index + 1} / ${currentModalGallery.length}`
        : (item.label || '');

    const fileName = `${currentModalFileNamePrefix}_${index + 1}.png`;
    dl.href = item.src;
    dl.download = fileName;
    dl.onclick = (e) => forceDownload(e, item.src, fileName);

    const showNav = currentModalGallery.length > 1;
    prevBtn.classList.toggle('hidden', !showNav);
    nextBtn.classList.toggle('hidden', !showNav);

    modal.classList.add('open');
}

function openPreviewGallery(items, startIndex = 0, fileNamePrefix = 'banana_gen') {
    const normalized = (Array.isArray(items) ? items : [items]).map((item, idx) => normalizePreviewItem(item, `图片 ${idx + 1}`)).filter(Boolean);
    if (normalized.length === 0) return;
    currentModalGallery = normalized;
    currentModalFileNamePrefix = String(fileNamePrefix || 'banana_gen').replace(/[^\w\-]+/g, '_');
    const safeIndex = Math.max(0, Math.min(normalized.length - 1, parseInt(startIndex, 10) || 0));
    renderModalGalleryItem(safeIndex);
}

function showModalGalleryStep(offset) {
    if (!Array.isArray(currentModalGallery) || currentModalGallery.length <= 1) return;
    const nextIndex = (currentModalIndex + offset + currentModalGallery.length) % currentModalGallery.length;
    renderModalGalleryItem(nextIndex);
}

function openPreviewFromUrl(src, prompt) {
    openPreviewGallery([{ src, prompt: prompt || '', label: '图片' }], 0, 'banana_gen');
}

function closeModal() {
    document.getElementById('imageModal').classList.remove('open');
}
document.getElementById('imageModal').addEventListener('click', (e) => {
    // 点击背景或 modal-content 的空白区域（非图片/信息区域）关闭
    const modalImg = document.getElementById('modalImg');
    const modalInfo = document.querySelector('.modal-info');
    const prevBtn = document.getElementById('modalPrevBtn');
    const nextBtn = document.getElementById('modalNextBtn');
    
    // 如果点击的不是图片、信息区域或关闭按钮，则关闭
    if (!modalImg.contains(e.target)
        && !modalInfo.contains(e.target)
        && !prevBtn.contains(e.target)
        && !nextBtn.contains(e.target)) {
        closeModal();
    }
});

document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('imageModal');
    if (!modal || !modal.classList.contains('open')) return;
    if (e.key === 'Escape') {
        closeModal();
        return;
    }
    if (e.key === 'ArrowLeft') {
        showModalGalleryStep(-1);
    } else if (e.key === 'ArrowRight') {
        showModalGalleryStep(1);
    }
});

// ========== 图像对比功能 ==========
let currentCompareCardId = null;
let currentRefIndex = 0;

function openCompareModal(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;
    
    currentCompareCardId = cardId;
    const files = getCardFiles(cardId);
    const genImgSrc = card.dataset.imgSrc;
    
    if (!files || files.length === 0 || !genImgSrc) {
        showToast('没有参考图可对比');
        return;
    }
    
    // 获取参考图
    const imageFiles = files.filter(f => f.type && f.type.startsWith('image/'));
    if (imageFiles.length === 0) {
        showToast('没有参考图可对比');
        return;
    }
    
    // 设置生成图
    document.getElementById('compareGenImg').src = genImgSrc;
    
    // 加载第一张参考图
    loadRefImage(0);
    
    // 生成缩略图
    renderCompareThumbnails(imageFiles);
    
    // 重置滑块位置
    const slider = document.getElementById('compareSlider');
    const wrapper = document.getElementById('compareWrapper');
    slider.style.left = '50%';
    document.getElementById('compareTop').style.clipPath = 'inset(0 0 0 50%)';
    
    // 显示 Modal
    document.getElementById('compareModal').classList.add('open');
}

function loadRefImage(index) {
    const files = getCardFiles(currentCompareCardId);
    if (!files) return;
    
    const imageFiles = files.filter(f => f.type && f.type.startsWith('image/'));
    if (index < 0 || index >= imageFiles.length) return;
    
    currentRefIndex = index;
    
    const file = imageFiles[index];
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('compareRefImg').src = e.target.result;
    };
    reader.readAsDataURL(file);
    
    // 更新缩略图选中状态
    document.querySelectorAll('.compare-thumb').forEach((thumb, i) => {
        thumb.classList.toggle('active', i === index);
    });
}

function renderCompareThumbnails(imageFiles) {
    const container = document.getElementById('compareThumbnails');
    container.innerHTML = '';
    
    imageFiles.forEach((file, index) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const div = document.createElement('div');
            div.className = 'compare-thumb' + (index === 0 ? ' active' : '');
            div.innerHTML = `<img src="${e.target.result}" alt="参考图 ${index + 1}">`;
            div.onclick = () => loadRefImage(index);
            container.appendChild(div);
        };
        reader.readAsDataURL(file);
    });
}

function closeCompareModal() {
    document.getElementById('compareModal').classList.remove('open');
    currentCompareCardId = null;
}

// 图像对比滑块交互
(function() {
    const slider = document.getElementById('compareSlider');
    const wrapper = document.getElementById('compareWrapper');
    const topLayer = document.getElementById('compareTop');
    
    if (!slider || !wrapper) return;
    
    function updateSliderPosition(clientX) {
        const rect = wrapper.getBoundingClientRect();
        let percentage = ((clientX - rect.left) / rect.width) * 100;
        percentage = Math.max(0, Math.min(100, percentage));
        
        slider.style.left = percentage + '%';
        // 使用 clip-path 控制上层显示范围
        topLayer.style.clipPath = `inset(0 0 0 ${percentage}%)`;
    }
    
    // 悬停即可滑动（不需要点击）
    wrapper.addEventListener('mousemove', (e) => {
        updateSliderPosition(e.clientX);
    });
    
    // 触摸滑动支持
    wrapper.addEventListener('touchmove', (e) => {
        e.preventDefault();
        updateSliderPosition(e.touches[0].clientX);
    }, { passive: false });
})();

// 对比 Modal 点击背景关闭
document.getElementById('compareModal').addEventListener('click', (e) => {
    if (e.target.id === 'compareModal') {
        closeCompareModal();
    }
});

// --- API 调用 & 并发队列逻辑 ---

function updateMode() {
    const modeSelect = document.getElementById('modeSelect');
    const fileInput = document.getElementById('fileInput');
    const uploadBtn = document.getElementById('uploadBtn');
    const prompt = document.getElementById('prompt');
    const aspectRatioSelect = document.getElementById('aspectRatio');
    const imageSizeSelect = document.getElementById('imageSizeSelect');
    const modelSelect = document.getElementById('modelSelect');

    const mode = modeSelect.value;

    if (mode === 'image-generation') {
        fileInput.accept = 'image/*';
        uploadBtn.title = '上传参考图';
        prompt.placeholder = '在此输入提示词，或粘贴/拖入图片...';
        aspectRatioSelect.disabled = false;
        imageSizeSelect.disabled = false;
        // 启用比例和尺寸下拉菜单
        document.getElementById('ratioWrapper').style.opacity = '1';
        document.getElementById('ratioWrapper').style.pointerEvents = 'auto';
        document.getElementById('sizeWrapper').style.opacity = '1';
        document.getElementById('sizeWrapper').style.pointerEvents = 'auto';
        // 默认选择图片生成模型
        modelSelect.value = 'nano-banana-fast';
    } else {
        fileInput.accept = 'image/*';
        uploadBtn.title = '上传图片进行反推';
        prompt.placeholder = '可选：输入关于图片的问题，或直接上传图片进行反推...';
        aspectRatioSelect.disabled = true;
        imageSizeSelect.disabled = true;
        // 禁用比例和尺寸下拉菜单
        document.getElementById('ratioWrapper').style.opacity = '0.5';
        document.getElementById('ratioWrapper').style.pointerEvents = 'none';
        document.getElementById('sizeWrapper').style.opacity = '0.5';
        document.getElementById('sizeWrapper').style.pointerEvents = 'none';
        // 默认选择反推模型
        modelSelect.value = 'gemini-3.1-pro';
    }
    
    // 更新模型下拉菜单的选中状态和可见性
    updateModelDropdownForMode(mode);
    
    // 更新费用显示
    updatePriceDisplay(modelSelect.value);
}

function updateModelDropdownForMode(mode) {
    const currentValue = document.getElementById('modelSelect').value;
    
    document.querySelectorAll('.model-dropdown-item').forEach(item => {
        const itemMode = item.getAttribute('data-mode');
        
        // 根据当前模式显示/隐藏模型选项
        if (itemMode === mode) {
            item.style.display = 'block';
        } else {
            item.style.display = 'none';
        }
        
        // 更新选中状态
        item.classList.remove('selected');
        if (item.textContent === currentValue) {
            item.classList.add('selected');
        }
    });
}

function syncConfigFromUI() {
    const retryLimitInput = document.getElementById("retryLimitInput");
    const retryVal = parseInt(retryLimitInput.value, 10);
    retryLimit = Math.min(9, Math.max(0, isNaN(retryVal) ? 1 : retryVal));
    retryLimitInput.value = retryLimit;
}

function callAPI() {
    syncConfigFromUI();

    const promptText = document.getElementById("prompt").value.trim();
    const token = document.getElementById("token").value.trim();
    const drawApiBase = document.getElementById("drawApiBase").value.trim();
    const chatApiBase = document.getElementById("chatApiBase").value.trim();
    
    const aspectRatioElement = document.getElementById("aspectRatio");
    const aspectRatio = aspectRatioElement ? aspectRatioElement.value : "auto";
    
    const model = getSelectedModel();
    const imageSizeSelect = document.getElementById("imageSizeSelect");
    const modeSelect = document.getElementById("modeSelect");
    const imageSize = imageSizeSelect ? imageSizeSelect.value : "1K";
    const mode = modeSelect ? modeSelect.value : "image-generation";
    const isModelScopeRecognition = mode === 'media-recognition' && (model.startsWith('Qwen/') || model.includes('Qwen3') || model.startsWith('moonshotai/'));
    const historyList = document.getElementById('historyList');
    const emptyState = document.getElementById('emptyState');

    if (isModelScopeRecognition) {
        const modelscopeToken = document.getElementById("modelscopeToken")?.value?.trim();
        if (!modelscopeToken) { alert("请先填写 ModelScope Token"); return; }
    } else if (!token) {
        alert("请先填写 API Token");
        return;
    }

    if (mode === 'image-generation') {
        if (!promptText && uploadedFiles.length === 0) { alert("请输入提示词"); return; }
    }

    emptyState.style.display = 'none';

    const enqueueTask = (files, promptForCard) => {
        const taskId = ++taskIdCounter;
        const task = {
            id: taskId,
            prompt: promptText || (mode === 'image-generation' ? "图片参考生成" : "图片反推"),
            token,
            drawApiBase,
            chatApiBase,
            aspectRatio,
            model,
            imageSize,
            mode,
            files: files,
            attempts: 0,
            status: 'queued',
            controller: null,
            card: createTaskCard(taskId, promptForCard)
        };
        historyList.appendChild(task.card);
        taskQueue.push(task);
    };

    // 单次点击始终只创建一个任务；是否并发由多次点击+队列控制
    requestAnimationFrame(() => {
        enqueueTask([...uploadedFiles], promptText || (mode === 'image-generation' ? "图片参考生成" : "图片反推"));
        processQueue();
    });

    scrollToBottom();
}

function createTaskCard(taskId, promptText) {
    const safePrompt = escapeHTML(promptText);
    const card = document.createElement('div');
    card.className = 'result-card';
    card.id = `task-${taskId}`;
    card.innerHTML = `
        <div class="result-header" style="align-items: center;">
            <span class="result-prompt">提示词: ${safePrompt}</span>
            <div style="display: flex; align-items: center; gap: 10px;">
                <span id="task-timer-${taskId}" style="color: var(--text-sub); font-size: 12px; font-family: monospace;"><i class="fas fa-clock"></i> 00:00</span>
                <span id="task-status-${taskId}" style="color: var(--primary);">排队中</span>
            </div>
        </div>
        <div style="padding: 20px; text-align: center; color: var(--primary);">
            <i class="fas fa-palette spinner" style="font-size: 22px;"></i>
            <p id="task-msg-${taskId}" style="margin-top: 8px; font-size: 13px;">正在排队，稍后自动开始</p>
        </div>
        <div class="action-bar">
            <button class="btn-secondary" style="background:var(--bg-error-light); color:var(--text-error); border-color:var(--border-error);" onclick="cancelTask(${taskId})">
            <i class="fas fa-ban"></i> 取消任务
        </button>
        </div>
    `;
    return card;
}

function updateTaskUI(task, statusText, msgText, color = 'var(--primary)') {
    const statusEl = document.getElementById(`task-status-${task.id}`);
    const msgEl = document.getElementById(`task-msg-${task.id}`);
    if (statusEl) statusEl.textContent = statusText;
    if (statusEl) statusEl.style.color = color;
    if (msgEl) msgEl.textContent = msgText;
}

// 更新任务计时器显示
function updateTaskTimer(taskId) {
    const task = runningTasks.get(taskId) || failedTasks.get(taskId);
    const timerEl = document.getElementById(`task-timer-${taskId}`);
    
    if (!timerEl) return;
    
    if (task && task.startTime) {
        const elapsed = Math.floor((Date.now() - task.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        timerEl.innerHTML = `<i class="fas fa-clock"></i> ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
}

// 停止任务计时器
function stopTaskTimer(task) {
    if (task.timerInterval) {
        clearInterval(task.timerInterval);
        task.timerInterval = null;
    }
}

function updateFailedTaskButtons(task) {
    const card = document.getElementById(`task-${task.id}`);
    if (!card) return;
    
    const contentDiv = card.querySelector('div[style*="padding: 20px"]');
    if (contentDiv) {
        const msgEl = document.getElementById(`task-msg-${task.id}`);
        const errorMsg = msgEl ? msgEl.textContent : "任务失败";
        contentDiv.innerHTML = `
            <i class="fas fa-exclamation-circle" style="font-size: 24px; color: #ef4444;"></i>
            <p id="task-msg-${task.id}" style="margin-top: 8px; font-size: 13px; color: #ef4444;">${errorMsg}</p>
        `;
    }
    
    const actionBar = card.querySelector('.action-bar');
    if (actionBar) {
        actionBar.innerHTML = `
            <button class="btn-secondary" style="background:var(--bg-secondary); color:var(--text-secondary); border-color:var(--border-secondary);" onclick="retryFailedTask(${task.id})">
                <i class="fas fa-redo"></i> 继续重试
            </button>
            <button class="btn-secondary" style="background:var(--bg-error-light); color:var(--text-error); border-color:var(--border-error);" onclick="cancelTask(${task.id})">
                <i class="fas fa-ban"></i> 取消任务
            </button>
        `;
    }
}

function retryFailedTask(taskId) {
    const task = failedTasks.get(taskId);
    if (!task) {
        const card = document.getElementById(`task-${taskId}`);
        if (card) {
            alert("无法继续重试：任务信息已丢失");
        }
        return;
    }
    
    task.status = 'queued';
    task.attempts = 0;
    failedTasks.delete(taskId);
    
    updateTaskUI(task, "排队中", "已加入重试队列，等待执行...", "var(--primary)");
    
    const card = document.getElementById(`task-${task.id}`);
    if (card) {
        const contentDiv = card.querySelector('div[style*="padding: 20px"]');
        if (contentDiv) {
            contentDiv.innerHTML = `
                <i class="fas fa-palette spinner" style="font-size: 22px;"></i>
                <p id="task-msg-${task.id}" style="margin-top: 8px; font-size: 13px;">已加入重试队列，等待执行...</p>
            `;
        }
        const actionBar = card.querySelector('.action-bar');
        if (actionBar) {
            actionBar.innerHTML = `
                <button class="btn-secondary" style="background:var(--bg-error-light); color:var(--text-error); border-color:var(--border-error);" onclick="cancelTask(${task.id})">
                    <i class="fas fa-ban"></i> 取消任务
                </button>
            `;
        }
    }
    
    taskQueue.push(task);
    processQueue();
}

function cancelTask(taskId) {
    const queuedIndex = taskQueue.findIndex(t => t.id === taskId);
    if (queuedIndex !== -1) {
        const [task] = taskQueue.splice(queuedIndex, 1);
        updateTaskUI(task, "已取消", "已从队列移除", "#9ca3af");
        setTimeout(() => task.card.remove(), 1500);
        return;
    }
    
    const runningTask = runningTasks.get(taskId);
    if (runningTask) {
        stopTaskTimer(runningTask); // 停止计时器
        runningTask.controller?.abort();
        updateTaskUI(runningTask, "取消中", "正在停止请求...", "#9ca3af");
        runningTasks.delete(taskId);
        return;
    }
    
    const failedTask = failedTasks.get(taskId);
    if (failedTask) {
        stopTaskTimer(failedTask); // 停止计时器
        failedTasks.delete(taskId);
        updateTaskUI(failedTask, "已取消", "任务已移除", "#9ca3af");
        setTimeout(() => failedTask.card.remove(), 1500);
        return;
    }
    
    const card = document.getElementById(`task-${taskId}`);
    if (card) {
        updateTaskUI({ id: taskId }, "已取消", "任务已移除", "#9ca3af");
        setTimeout(() => card.remove(), 1500);
    }
}

function processQueue() {
    while (runningTasks.size < maxParallel && taskQueue.length > 0) {
        const task = taskQueue.shift();
        startTask(task);
    }
}

async function startTask(task) {
    task.attempts += 1;
    task.status = 'running';
    task.controller = new AbortController();
    runningTasks.set(task.id, task);
    
    // 初始化计时器
    task.startTime = Date.now();
    task.timerInterval = setInterval(() => updateTaskTimer(task.id), 1000);
    updateTaskTimer(task.id);

    const statusText = task.mode === 'media-recognition' ? '正在反推，请勿刷新或关闭页面...' : '正在绘制，请勿刷新或关闭页面...';
    updateTaskUI(task, `执行中（第 ${task.attempts} 次）`, statusText);

    try {
        let result;

        if (task.mode === 'media-recognition') {
            result = await runMediaRecognition(task);
        } else {
            result = await runGeneration(task);
        }

        // 计算耗时
        const elapsed = Math.floor((Date.now() - task.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const timeStr = `${minutes}分${seconds}秒`;

        const historyList = document.getElementById('historyList');
        let newCard;
        const targetResolution = calculateTargetResolution(task.imageSize, task.aspectRatio);

        if (task.mode === 'media-recognition') {
            newCard = createTextResultCard(result, task.prompt, task.files[0]?.name || '未知文件', task.files, timeStr, task.model);
            saveToDB(result, task.prompt, 'recognition', task.files, { model: task.model, taskMode: task.mode || 'recognition' }).then(historyId => {
                if (historyId && newCard) {
                    newCard.dataset.historyId = historyId;
                }
                addTaskResultNotification({
                    historyId,
                    cardId: newCard?.id || '',
                    taskId: task.id,
                    taskType: 'regular',
                    stage: 'reverse',
                    status: 'success',
                    title: '图片反推完成',
                    message: '点击查看反推结果'
                });
            }).catch(err => {
                console.error('Save to DB error:', err);
            });
        } else {
            // 创建卡片
            newCard = createResultCard(result, task.prompt, timeStr, task.model, task.files, task.aspectRatio, task.imageSize);
            
            // 立即保存到数据库，不等待图片加载
            const targetResolution = calculateTargetResolution(task.imageSize, task.aspectRatio);
            
            // 先获取图片尺寸
            let actualResolution = null;
            const img = new Image();
            const imgLoadPromise = new Promise((resolve) => {
                img.onload = function() {
                    actualResolution = { width: img.naturalWidth, height: img.naturalHeight };
                    resolve();
                };
                img.onerror = () => resolve(); // 图片加载失败也继续
            });
            img.src = result;
            
            // 等待图片加载完成后再保存
            await imgLoadPromise;
            
            saveToDB(result, task.prompt, 'image', task.files, {
                aspectRatio: task.aspectRatio,
                imageSize: task.imageSize,
                targetResolution: targetResolution,
                model: task.model,
                actualResolution: actualResolution,
                taskMode: task.mode || 'single'
            }).then(historyId => {
                debugLog('Image saved, historyId:', historyId, 'newCard exists:', !!newCard, 'newCard in DOM:', newCard?.parentNode != null);
                if (historyId && newCard) {
                    newCard.dataset.historyId = historyId;
                }
                addTaskResultNotification({
                    historyId,
                    cardId: newCard?.id || '',
                    taskId: task.id,
                    taskType: 'regular',
                    stage: 'generate',
                    status: 'success',
                    title: '图片生成完成',
                    message: '点击查看生成图片'
                });
            }).catch(err => {
                console.error('Save to DB error:', err);
            });
        }

        // 使用 requestAnimationFrame 批量添加到 DOM，减少重排
        requestAnimationFrame(() => {
            historyList.appendChild(newCard);
        });

        // 停止计时器并显示总时间
        stopTaskTimer(task);
        debugLog(`✅ 任务 ${task.id} 完成，总耗时: ${minutes}分${seconds}秒`);

        task.card.remove();
        runningTasks.delete(task.id);
        failedTasks.delete(task.id);

        scrollToBottom();
        processQueue();
    } catch (error) {
        if (task.controller?.signal.aborted) {
            stopTaskTimer(task);
            updateTaskUI(task, "已取消", "任务已停止", "#9ca3af");
            runningTasks.delete(task.id);
            setTimeout(() => task.card.remove(), 1500);
            processQueue();
            return;
        }

        if (task.attempts <= retryLimit) {
            stopTaskTimer(task); // 重试前先停止计时器，重试时会重新开始
            updateTaskUI(task, `失败重试（第 ${task.attempts} 次）`, `错误：${error.message || error}，即将重试...`, "#f59e0b");
            task.status = 'queued';
            runningTasks.delete(task.id);
            taskQueue.push(task);
            setTimeout(() => processQueue(), 600);
        } else {
            stopTaskTimer(task);
            task.status = 'failed';
            failedTasks.set(task.id, task);
            updateTaskUI(task, "失败", `多次重试仍失败：${error.message || error}`, "#ef4444");
            updateFailedTaskButtons(task);
            addTaskResultNotification({
                cardId: task.card?.id || `task-${task.id}`,
                taskId: task.id,
                taskType: 'regular',
                stage: task.mode === 'media-recognition' ? 'reverse' : 'generate',
                status: 'failed',
                title: task.mode === 'media-recognition' ? '图片反推失败' : '图片生成失败',
                message: error.message || String(error || '任务失败')
            });
            runningTasks.delete(task.id);
        }
    }
}

function calculateTargetResolution(imageSize, aspectRatio) {
    const resolutionMap = {
        "1K": 1024,
        "2K": 2048,
        "4K": 4096
    };
    
    const aspectRatioMap = {
        "auto": (size) => ({ width: size, height: size }),
        "1:1": (size) => ({ width: size, height: size }),
        "4:3": (size) => ({ width: Math.round(size * 4/3), height: size }),
        "5:4": (size) => ({ width: Math.round(size * 5/4), height: size }),
        "16:9": (size) => ({ width: Math.round(size * 16/9), height: size }),
        "3:4": (size) => ({ width: Math.round(size * 3/4), height: size }),
        "4:5": (size) => ({ width: Math.round(size * 4/5), height: size }),
        "9:16": (size) => ({ width: Math.round(size * 9/16), height: size }),
        "2:3": (size) => ({ width: Math.round(size * 2/3), height: size }),
        "3:2": (size) => ({ width: Math.round(size * 3/2), height: size }),
        "21:9": (size) => ({ width: Math.round(size * 21/9), height: size }),
        "9:21": (size) => ({ width: Math.round(size * 9/21), height: size }),
        "1:2": (size) => ({ width: Math.round(size * 1/2), height: size }),
        "2:1": (size) => ({ width: Math.round(size * 2/1), height: size }),
        "1:3": (size) => ({ width: Math.round(size * 1/3), height: size }),
        "3:1": (size) => ({ width: Math.round(size * 3/1), height: size })
    };
    
    const baseSize = resolutionMap[imageSize] || 2048;
    const ratioFunc = aspectRatioMap[aspectRatio] || aspectRatioMap["auto"];
    return ratioFunc(baseSize);
}

function parseGPTImage2Ratio(aspectRatio) {
    if (!aspectRatio || aspectRatio === 'auto') return { w: 1, h: 1 };
    const parts = String(aspectRatio).split(':').map(Number);
    let w = Number.isFinite(parts[0]) && parts[0] > 0 ? parts[0] : 1;
    let h = Number.isFinite(parts[1]) && parts[1] > 0 ? parts[1] : 1;
    if (w / h > 3) w = h * 3;
    if (h / w > 3) h = w * 3;
    return { w, h };
}

function roundGPTImage2Multiple(value, mode = 'nearest') {
    const multiple = 16;
    if (mode === 'floor') return Math.max(multiple, Math.floor(value / multiple) * multiple);
    if (mode === 'ceil') return Math.max(multiple, Math.ceil(value / multiple) * multiple);
    return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function fitGPTImage2OfficialLimits(width, height) {
    const maxSide = 3840;
    const minPixels = 655360;
    const maxPixels = 8294400;
    let w = roundGPTImage2Multiple(width);
    let h = roundGPTImage2Multiple(height);

    if (Math.max(w, h) > maxSide) {
        const scale = maxSide / Math.max(w, h);
        w = roundGPTImage2Multiple(w * scale);
        h = roundGPTImage2Multiple(h * scale);
    }

    if (w * h > maxPixels) {
        const scale = Math.sqrt(maxPixels / (w * h));
        w = roundGPTImage2Multiple(w * scale);
        h = roundGPTImage2Multiple(h * scale);
        while (w * h > maxPixels) {
            if (w >= h) w -= 16;
            else h -= 16;
        }
    }

    if (w * h < minPixels) {
        const scale = Math.sqrt(minPixels / (w * h));
        w = roundGPTImage2Multiple(w * scale, 'ceil');
        h = roundGPTImage2Multiple(h * scale, 'ceil');
    }

    if (w / h > 3) w = roundGPTImage2Multiple(h * 3, 'floor');
    if (h / w > 3) h = roundGPTImage2Multiple(w * 3, 'floor');

    return { width: w, height: h };
}

function calculateGPTImage2Size(imageSize, aspectRatio) {
    const { w: rw, h: rh } = parseGPTImage2Ratio(aspectRatio);
    const ratio = rw / rh;
    let width;
    let height;

    if (imageSize === '4K') {
        if (ratio >= 1) {
            width = 3840;
            height = 3840 / ratio;
        } else {
            height = 3840;
            width = 3840 * ratio;
        }
    } else if (imageSize === '2K') {
        if (ratio >= 1) {
            width = 2048;
            height = 2048 / ratio;
        } else {
            height = 2048;
            width = 2048 * ratio;
        }
    } else {
        if (ratio >= 1) {
            height = 1024;
            width = 1024 * ratio;
        } else {
            width = 1024;
            height = 1024 / ratio;
        }
    }

    const fitted = fitGPTImage2OfficialLimits(width, height);
    return `${fitted.width}x${fitted.height}`;
}


// ========== 核心：Banana 图片生成 API ==========
async function runGeneration(task) {
    const apiBase = task.drawApiBase || getDefaultDrawApiBase();
    
    // GPT Image-2 使用不同的 API 端点
    const isGPTImage2 = isGPTImage2Model(task.model);
    const submitUrl = `${apiBase.replace(/\/$/, '')}${isGPTImage2 ? '/v1/draw/completions' : '/v1/draw/nano-banana'}`;
    const resultUrl = `${apiBase.replace(/\/$/, '')}/v1/draw/result`;

    debugLog("🎨 ========== 图片生成模式 ==========");
    debugLog("🚀 提交端点:", submitUrl);
    debugLog("🚀 模型:", task.model);

    // 1. 如果有上传的图片，需要先上传获取URL
    let imageUrls = [];
    if (task.files.length > 0) {
        debugLog("📸 处理参考图片...");
        for (const file of task.files) {
            try {
                // 将图片转为base64 data URL作为参考图URL
                const base64Data = await fileToBase64(file);
                const dataUrl = `data:${file.type};base64,${base64Data}`;
                imageUrls.push(dataUrl);
            } catch (err) {
                console.error("❌ 处理参考图失败:", err);
            }
        }
    }

    // 2. 构造 API 请求体
    let payload;
    if (isGPTImage2) {
        // GPT Image-2 系列 API 格式
        const gptSize = calculateGPTImage2Size(task.imageSize || "1K", task.aspectRatio || "1:1");
        const gptQuality = task.model === 'gpt-image-2-vip'
            ? (GPT_IMAGE2_QUALITY_MAP[task.imageSize] || 'low')
            : undefined;
        payload = {
            model: task.model === 'gpt-image-2-vip' ? 'gpt-image-2-vip' : 'gpt-image-2',
            prompt: task.prompt || "Generate a beautiful image",
            size: gptSize,
            ...(gptQuality ? { quality: gptQuality } : {}),
            urls: imageUrls,
            webHook: "-1",
            shutProgress: false
        };
        if (task.model === 'gpt-image-2-vip') {
            debugLog("🧪 GPT Image-2 VIP size测试:", payload.size, "quality:", payload.quality);
        }
    } else {
        // Banana API 格式
        payload = {
            model: task.model || "nano-banana-fast",
            prompt: task.prompt || "Generate a beautiful image",
            aspectRatio: task.aspectRatio || "auto",
            imageSize: task.imageSize || "1K",
            urls: imageUrls,
            webHook: "-1",
            shutProgress: true
        };
    }

    debugLog("📦 请求体:", JSON.stringify({
        ...payload,
        urls: imageUrls.length > 0 ? `[${imageUrls.length} images]` : []
    }, null, 2));

    // 3. 提交生成任务
    const submitResponse = await fetch(submitUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${task.token}`
        },
        body: JSON.stringify(payload),
        signal: task.controller?.signal
    });

    debugLog("📡 提交响应状态:", submitResponse.status, submitResponse.statusText);

    if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        console.error("❌ 提交任务失败，响应文本:", errorText);
        try {
            const errorData = JSON.parse(errorText);
            throw new Error(errorData.msg || errorData.message || `HTTP ${submitResponse.status}`);
        } catch (e) {
            throw new Error(`HTTP ${submitResponse.status}: ${errorText.substring(0, 200)}`);
        }
    }

    const responseText = await submitResponse.text();
    debugLog("📨 提交响应原始文本:", responseText);
    
    let submitData;
    try {
        submitData = JSON.parse(responseText);
    } catch (e) {
        console.error("❌ JSON解析失败，可能是SSE格式");
        throw new Error("API返回格式错误，请检查是否需要设置webHook参数");
    }
    
    debugLog("📨 提交响应JSON:", JSON.stringify(submitData, null, 2));

    if (submitData.code !== 0 || !submitData.data?.id) {
        throw new Error(submitData.msg || "提交任务失败，未获取到任务ID");
    }

    const taskId = submitData.data.id;
    debugLog("✅ 任务已提交，ID:", taskId);

    // GPT Image-2 可能直接返回结果
    if (isGPTImage2 && submitData.data.status === "succeeded" && submitData.data.results) {
        const result = submitData.data.results[0];
        if (result?.url) {
            debugLog("✅ GPT Image-2 直接返回结果:", result.url);
            return result.url;
        }
    }

    // 4. 轮询获取结果（无限轮询，直到成功或取消）
    const pollingInterval = 1000; // 每秒轮询一次
    let attempt = 0;

    while (true) {
        attempt++;
        
        // 检查是否被取消
        if (task.controller?.signal.aborted) {
            throw new Error("任务已取消");
        }

        debugLog(`🔄 轮询第 ${attempt} 次...`);

        const resultResponse = await fetch(resultUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${task.token}`
            },
            body: JSON.stringify({ id: taskId }),
            signal: task.controller?.signal
        });

        if (!resultResponse.ok) {
            debugWarn(`⚠️ 轮询失败，状态: ${resultResponse.status}`);
            await new Promise(resolve => setTimeout(resolve, pollingInterval));
            continue;
        }

        const resultText = await resultResponse.text();
        debugLog(`📨 轮询响应原始文本 (${attempt}):`, resultText);
        
        let resultData;
        try {
            resultData = JSON.parse(resultText);
        } catch (e) {
            debugWarn(`⚠️ JSON解析失败`);
            await new Promise(resolve => setTimeout(resolve, pollingInterval));
            continue;
        }
        
        debugLog(`📨 轮询响应JSON (${attempt}):`, JSON.stringify(resultData, null, 2));

        if (resultData.code !== 0) {
            debugWarn(`⚠️ 轮询返回错误:`, resultData.msg);
            await new Promise(resolve => setTimeout(resolve, pollingInterval));
            continue;
        }

        const data = resultData.data;
        
        // 详细打印data结构
        debugLog("📊 data结构:", {
            status: data?.status,
            progress: data?.progress,
            hasResults: !!(data?.results),
            resultsLength: data?.results?.length
        });
        
        if (data && data.status === "succeeded" && data.results && data.results.length > 0) {
            debugLog("✅ 图片生成成功！");
            const result = data.results[0];
            debugLog("📊 result结构:", {
                url: result.url ? result.url.substring(0, 100) + '...' : null,
                content: result.content ? result.content.substring(0, 50) + '...' : null
            });
            
            // 返回图片URL
            if (result.url) {
                // 检查是否是完整的URL
                if (result.url.startsWith('http://') || result.url.startsWith('https://')) {
                    try {
                        debugLog("📥 尝试下载图片:", result.url);
                        const imgResponse = await fetch(result.url);
                        if (!imgResponse.ok) {
                            debugWarn("⚠️ 下载图片失败，直接使用URL");
                            return result.url;
                        }
                        const blob = await imgResponse.blob();
                        debugLog("📥 Blob大小:", blob.size, "类型:", blob.type);
                        const base64 = await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result);
                            reader.onerror = reject;
                            reader.readAsDataURL(blob);
                        });
                        debugLog("✅ 图片已下载并转为base64，长度:", base64.length);
                        return base64;
                    } catch (err) {
                        debugWarn("⚠️ 无法下载图片:", err);
                        return result.url;
                    }
                } else if (result.url.startsWith('data:')) {
                    // 已经是data URI格式
                    debugLog("✅ URL是data URI格式");
                    return result.url;
                } else {
                    // 可能是base64字符串
                    debugLog("✅ URL可能是base64，添加前缀");
                    return `data:image/png;base64,${result.url}`;
                }
            } else if (result.content) {
                // content字段可能是描述文字，不是图片
                debugLog("⚠️ content字段:", result.content.substring(0, 100));
                throw new Error("未返回图片URL，只有内容描述");
            } else {
                throw new Error("返回结果中未找到图片URL");
            }
        } else if (data && data.status === "failed") {
            throw new Error(data.failure_reason || data.error || "图片生成失败");
        } else if (data && data.progress !== undefined) {
            updateTaskUI(task, `生成中`, `生成进度: ${data.progress}%`, "var(--primary)");
        } else if (data && data.status === "running") {
            updateTaskUI(task, `生成中`, `正在生成中，请稍候...`, "var(--primary)");
        } else if (data && data.status === "pending") {
            updateTaskUI(task, `排队中`, `任务排队中，请稍候...`, "var(--primary)");
        }

        // 等待后继续轮询
        await new Promise(resolve => setTimeout(resolve, pollingInterval));
    }
    // 注意：while(true) 循环永远不会到达这里，除非任务被取消（通过 throw Error）
}

// ========== 核心：图片反推 API ==========
async function runMediaRecognition(task) {
    // 判断是否使用 ModelScope API（Qwen3、Kimi 等模型）
    const isModelScope = task.model.startsWith('Qwen/') || task.model.includes('Qwen3') || task.model.startsWith('moonshotai/');
    const isGPT55 = task.model === 'gpt-5.5';
    
    let apiBase, token, modelId;
    
    if (isModelScope) {
        // ModelScope API（Qwen3 模型）
        apiBase = "https://api-inference.modelscope.cn";
        token = document.getElementById("modelscopeToken")?.value?.trim();
        modelId = task.model;
        
        if (!token) {
            throw new Error("使用 Qwen3 模型需要填写 ModelScope Token");
        }
        
        debugLog("👁️ ========== 图片反推模式 (ModelScope/Qwen3) ==========");
    } else if (isGPT55) {
        // gpt-5.5 使用专用 API
        apiBase = "https://grsaiapi.com";
        token = task.token;
        modelId = task.model;
        
        debugLog("👁️ ========== 图片反推模式 (gpt-5.5) ==========");
    } else {
        // 默认 API（Gemini 等模型）
        apiBase = task.chatApiBase || getDefaultChatApiBase();
        token = task.token;
        modelId = task.model || "gemini-3.1-pro";
        
        debugLog("👁️ ========== 图片反推模式 ==========");
    }
    
    const url = `${apiBase.replace(/\/$/, '')}/v1/chat/completions`;

    debugLog("🚀 API端点:", url);
    debugLog("🚀 模型:", modelId);
    debugLog("🚀 提示词:", task.prompt);
    debugLog("🚀 上传文件数:", task.files.length);

    // 1. 构造消息内容
    const content = [];

    // 如果有上传的图片，添加图片内容
    if (task.files.length > 0) {
        debugLog("📸 处理图片...");
        for (const file of task.files) {
            if (file.type && file.type.startsWith('image/')) {
                // Qwen3 模型限制图片 5MB，需要压缩
                let processedFile = file;
                if (isModelScope) {
                    try {
                        processedFile = await compressImage(file, 5);
                    } catch (compressError) {
                        debugWarn("⚠️ 图片压缩失败，使用原图:", compressError.message);
                    }
                }
                
                const base64Data = await fileToBase64(processedFile);
                content.push({
                    type: "image_url",
                    image_url: {
                        url: `data:${processedFile.type};base64,${base64Data}`
                    }
                });
                debugLog("📸 添加图片:", processedFile.type, "长度:", base64Data.length);
            }
        }
    }

    // 2. 添加文本提示
    const textPrompt = task.prompt || "请详细描述这张图片的内容，包括主体、背景、颜色、风格、氛围等各方面细节。";
    content.push({
        type: "text",
        text: textPrompt
    });

    debugLog("📝 文本提示:", textPrompt);

    // 3. 构造请求体
    const payload = {
        model: modelId,
        stream: false,
        messages: [
            {
                role: "system",
                content: "You are a helpful assistant that can analyze images and provide detailed descriptions."
            },
            {
                role: "user",
                content: content
            }
        ]
    };

    debugLog("📦 请求体结构:", JSON.stringify({
        model: payload.model,
        stream: payload.stream,
        messages: payload.messages?.map(m => ({
            role: m.role,
            content: Array.isArray(m.content) 
                ? m.content.map(c => c.type === 'image_url' ? { type: 'image_url', image_url: { url: '[image data]' } } : c)
                : m.content
        })),
    }, null, 2));

    // 4. 发送请求
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify(payload),
        signal: task.controller?.signal
    });

    debugLog("📡 响应状态:", response.status, response.statusText);

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error("❌ API请求失败:", errorData);
        throw new Error(errorData.error?.message || errorData.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    debugLog("📨 ========== 图片反推响应 ==========");
    debugLog("📨 响应类型:", typeof data);
    debugLog("📨 响应键:", Object.keys(data));

    // 5. 解析返回的文本
    const text = parseTextFromResponse(data);

    if (!text) {
        console.error("❌ 未找到识别结果，完整响应:", JSON.stringify(data, null, 2));
        throw new Error("未找到识别结果，请检查API响应格式");
    }

    debugLog("✅ 识别结果:", text.substring(0, 200) + (text.length > 200 ? '...' : ''));
    return text;
}

// 解析API响应中的文本（支持兼容格式和Gemini原生格式）
function parseTextFromResponse(data) {
    // 聊天兼容格式
    if (data.choices && data.choices.length > 0) {
        const choice = data.choices[0];
        if (choice.message && choice.message.content) {
            const content = choice.message.content;

            if (typeof content === "string") {
                return content;
            }

            if (Array.isArray(content)) {
                for (const item of content) {
                    if (item.type === "text") {
                        return item.text;
                    }
                }
            }
        }
    }

    // Gemini 原生格式
    if (data.candidates && data.candidates.length > 0) {
        const parts = data.candidates[0].content?.parts || [];
        for (const part of parts) {
            if (part.text) {
                return part.text;
            }
        }
    }

    return null;
}

// ==================== 拆分代码段 ====================

// ==================== 对话控制台手机端收缩折叠功能 ====================
function toggleChatCollapse(event) {
    if (event) event.stopPropagation();
    const composer = document.getElementById('chatInputBox');
    if (!composer) return;
    
    const isCollapsed = composer.classList.toggle('chat-collapsed');
    
    // 更新折叠按钮图标
    const icon = document.querySelector('#chatCollapseToggle i');
    if (icon) {
        if (isCollapsed) {
            icon.className = 'fas fa-chevron-up';
        } else {
            icon.className = 'fas fa-chevron-down';
        }
    }
    
    // 自动更新提示文本的可见性
    const tip = document.getElementById('chatCollapsedTip');
    if (tip) {
        tip.style.display = isCollapsed ? 'flex' : 'none';
    }
}

// ==================== 输入控制台手机端收缩折叠功能 ====================
function toggleComposerFold(event) {
    if (event) event.stopPropagation();
    const composer = document.getElementById('dropZone');
    if (!composer) return;
    
    const isCollapsed = composer.classList.toggle('collapsed');
    
    // 更新折叠按钮图标
    const icon = document.querySelector('#composerFoldBtn i');
    if (icon) {
        if (isCollapsed) {
            icon.className = 'fas fa-chevron-up';
        } else {
            icon.className = 'fas fa-chevron-down';
        }
    }
    
    // 自动更新提示文本的可见性
    const tip = document.getElementById('composerCollapsedTip');
    if (tip) {
        tip.style.display = isCollapsed ? 'block' : 'none';
    }
}

// ==================== 自定义下拉菜单功能（比例/模式/尺寸） ====================
function toggleCustomSelect(menuId, event) {
    event.stopPropagation();
    const menu = document.getElementById(menuId);
    // 关闭其他所有下拉菜单
    document.querySelectorAll('.custom-select-menu.show, .model-dropdown-menu.show').forEach(m => {
        if (m.id !== menuId) m.classList.remove('show');
    });
    menu.classList.toggle('show');
    // 移动端：控制背景虚化遮罩
    const overlay = document.getElementById('chatSelectOverlay');
    if (overlay) overlay.classList.toggle('active', menu.classList.contains('show'));
}

function selectCustomOption(menuId, valueId, hiddenId, item, value) {
    // 更新显示文字
    document.getElementById(valueId).textContent = item.textContent;
    // 更新 hidden input
    document.getElementById(hiddenId).value = value;
    // 更新选中状态
    const menu = document.getElementById(menuId);
    menu.querySelectorAll('.custom-select-item').forEach(i => i.classList.remove('selected'));
    item.classList.add('selected');
    // 关闭菜单
    menu.classList.remove('show');
    // 移动端：隐藏遮罩
    const overlay = document.getElementById('chatSelectOverlay');
    if (overlay) overlay.classList.remove('active');
    // 触发比例变化事件（常规比例或套图比例）
    if (hiddenId === 'aspectRatio' || hiddenId === 'suiteRatioInput') {
        const evt = new Event('change', { bubbles: true });
        const targetEl = document.getElementById(hiddenId);
        if (targetEl) targetEl.dispatchEvent(evt);
    }
    // 触发尺寸变化事件
    if (hiddenId === 'imageSizeSelect') {
        updatePrice();
    }
}

function selectModeOption(item, mode) {
    const menu = document.getElementById('modeMenu');
    // 更新显示文字
    document.getElementById('modeValue').textContent = item.textContent;
    // 更新 hidden input
    document.getElementById('modeSelect').value = mode;
    // 更新选中状态
    menu.querySelectorAll('.custom-select-item').forEach(i => i.classList.remove('selected'));
    item.classList.add('selected');
    // 关闭菜单
    menu.classList.remove('show');
    // 移动端：隐藏遮罩
    const overlay = document.getElementById('chatSelectOverlay');
    if (overlay) overlay.classList.remove('active');
    // 调用原有的 updateMode 函数
    updateMode();
}

function bindDropdownWheelIsolation() {
    if (window.__dropdownWheelIsolationBound) return;
    window.__dropdownWheelIsolationBound = true;
    document.addEventListener('wheel', (e) => {
        const menu = e.target.closest('.custom-select-menu, .model-dropdown-menu');
        if (!menu || !menu.classList.contains('show')) return;
        if (menu.scrollHeight <= menu.clientHeight) return;
        e.preventDefault();
        e.stopPropagation();
        menu.scrollTop += e.deltaY;
    }, { passive: false, capture: true });
}

bindDropdownWheelIsolation();

// ==================== 模型下拉菜单功能 ====================
function toggleModelDropdown(event) {
    event.stopPropagation();
    const menu = document.getElementById('modelDropdownMenu');
    const btn = event.currentTarget;
    
    if (btn.classList.contains('model-input-btn') || btn.classList.contains('model-input-wrapper') || btn.tagName === 'INPUT') {
        // 关闭其他所有下拉菜单
        document.querySelectorAll('.custom-select-menu.show, .model-dropdown-menu.show').forEach(m => {
            if (m.id !== 'modelDropdownMenu') m.classList.remove('show');
        });
        menu.classList.toggle('show');
        if (menu.classList.contains('show')) {
            // 只显示当前模式对应的模型
            const currentMode = document.getElementById('modeSelect').value;
            document.querySelectorAll('.model-dropdown-item').forEach(item => {
                const itemMode = item.getAttribute('data-mode');
                if (itemMode === currentMode) {
                    item.style.display = 'block';
                } else {
                    item.style.display = 'none';
                }
            });
        }
        // 移动端：控制背景虚化遮罩
        const overlay = document.getElementById('chatSelectOverlay');
        if (overlay) overlay.classList.toggle('active', menu.classList.contains('show'));
    }
}

function selectModel(element) {
    const value = element.textContent;
    document.getElementById('modelSelect').value = value;
    
    document.querySelectorAll('.model-dropdown-item').forEach(item => {
        item.classList.remove('selected');
    });
    element.classList.add('selected');
    
    document.getElementById('modelDropdownMenu').classList.remove('show');
    // 移动端：隐藏遮罩
    const overlay = document.getElementById('chatSelectOverlay');
    if (overlay) overlay.classList.remove('active');
    
    // 更新费用显示
    updatePriceDisplay(value);
}

// 模型价格映射表
const MODEL_PRICES = {
    // 图片生成模型
    'nano-banana-fast': { type: 'fixed', price: 0.05, unit: '¥' },
    'nano-banana-2': { type: 'fixed', price: 0.12, unit: '¥' },
    'nano-banana-pro': { type: 'fixed', price: 0.18, unit: '¥' },
    'nano-banana-pro-vip': { type: 'fixed', price: 0.7, unit: '¥' },
    'nano-banana-pro-4k-vip': { type: 'fixed', price: 0.86, unit: '¥' },
    'GPT Image-2': { type: 'fixed', price: 0.06, unit: '¥' },
    'gpt-image-2-vip': { type: 'fixed', price: 0.13, unit: '¥' },
    // 图片反推模型
    'gemini-3.1-pro': { type: 'metered', text: '计量收费' },
    'gemini-3.1-flash-lite': { type: 'metered', text: '计量收费' },
    'gemini-3.5-flash': { type: 'metered', text: '计量收费' },
    'gpt-5.5': { type: 'metered', text: '计量收费' },
    'Qwen/Qwen3.5-397B-A17B': { type: 'free', text: '免费' },
    'moonshotai/Kimi-K2.5': { type: 'free', text: '免费' }
};

// GPT Image-2 系列质量映射
const GPT_IMAGE2_QUALITY_MAP = { '1K': 'low', '2K': 'medium', '4K': 'high' };
function isGPTImage2Model(model) { return model === 'GPT Image-2' || model === 'gpt-image-2-vip'; }

// 更新费用显示
function updatePriceDisplay(modelName) {
    const priceText = document.getElementById('priceText');
    if (!priceText) return;
    
    const priceInfo = MODEL_PRICES[modelName];
    
    if (!priceInfo) {
        priceText.innerHTML = '<span style="color: var(--text-sub);">未知</span>';
        return;
    }
    
    switch (priceInfo.type) {
        case 'fixed':
            priceText.innerHTML = `<span class="price-fixed">${priceInfo.unit}${priceInfo.price.toFixed(2)}</span>`;
            break;
        case 'metered':
            priceText.innerHTML = `<span class="price-metered">${priceInfo.text}</span>`;
            break;
        case 'free':
            priceText.innerHTML = `<span class="price-free">${priceInfo.text}</span>`;
            break;
        default:
            priceText.innerHTML = '<span style="color: var(--text-sub);">未知</span>';
    }
}

function getSelectedModel() {
    return document.getElementById('modelSelect').value.trim();
}

function filterModelOptions() {
    const input = document.getElementById('modelSelect').value.toLowerCase();
    const currentMode = document.getElementById('modeSelect').value;
    const items = document.querySelectorAll('.model-dropdown-item');
    
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        const itemMode = item.getAttribute('data-mode');
        
        // 只显示当前模式的模型，并且匹配搜索条件
        if (itemMode === currentMode && (text.includes(input) || input === '')) {
            item.style.display = 'block';
        } else {
            item.style.display = 'none';
        }
    });
    
    // 更新费用显示（使用输入框的值）
    const modelValue = document.getElementById('modelSelect').value;
    updatePriceDisplay(modelValue);
    
    const menu = document.getElementById('modelDropdownMenu');
    if (!menu.classList.contains('show')) {
        menu.classList.add('show');
    }
}

document.addEventListener('click', function(e) {
    // 关闭常规模型下拉菜单
    const dropdown = document.querySelector('.model-dropdown-wrapper');
    if (dropdown && !dropdown.contains(e.target)) {
        document.getElementById('modelDropdownMenu').classList.remove('show');
    }
    // 关闭套图模式的模型下拉菜单
    let suiteMenuClosed = false;
    document.querySelectorAll('.suite-composer .model-dropdown-wrapper').forEach(wrapper => {
        if (!wrapper.contains(e.target)) {
            wrapper.querySelectorAll('.model-dropdown-menu').forEach(menu => {
                if (menu.classList.contains('show')) suiteMenuClosed = true;
                menu.classList.remove('show');
            });
        }
    });
    if (suiteMenuClosed) toggleSuiteMobileBackdrop(false);
    // 关闭自定义下拉菜单（比例/模式/尺寸）
    document.querySelectorAll('.custom-select-wrapper').forEach(wrapper => {
        if (!wrapper.contains(e.target)) {
            wrapper.querySelectorAll('.custom-select-menu').forEach(menu => {
                menu.classList.remove('show');
            });
        }
    });
});

// ==================== 套图模式模型选择器 ====================
// 移动端遮罩层管理
function toggleSuiteMobileBackdrop(show) {
    if (window.innerWidth > 768) return;
    let bd = document.getElementById('suiteMobileBackdrop');
    if (show) {
        if (!bd) {
            bd = document.createElement('div');
            bd.id = 'suiteMobileBackdrop';
            bd.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.35);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:9998;';
            bd.addEventListener('click', () => {
                document.querySelectorAll('.suite-composer .model-dropdown-menu.show').forEach(m => m.classList.remove('show'));
                bd.remove();
            });
            document.body.appendChild(bd);
        }
    } else {
        if (bd) bd.remove();
    }
}

function toggleSuiteModelDropdown(event, type) {
    event.stopPropagation();
    const inputId = type === 'gen' ? 'suiteGenModelInput' : 'suiteVLModelInput';
    const menuId = type === 'gen' ? 'suiteGenModelMenu' : 'suiteVLModelMenu';
    const menu = document.getElementById(menuId);
    const inputEl = document.getElementById(inputId);
    const btn = event.currentTarget;
    
    if (btn.classList.contains('model-input-btn') || btn.classList.contains('model-input-wrapper') || btn.tagName === 'INPUT') {
        // 关闭其他菜单
        document.querySelectorAll('.suite-composer .model-dropdown-menu').forEach(m => {
            if (m.id !== menuId) m.classList.remove('show');
        });

        // 输入框点击：始终展开，避免“点开又收起”
        if (btn.tagName === 'INPUT') {
            menu.classList.add('show');
        } else {
            menu.classList.toggle('show');
        }

        // 移动端：切换遮罩层
        toggleSuiteMobileBackdrop(menu.classList.contains('show'));

        // 点击展开时恢复完整列表；输入过滤交给 oninput
        if (menu.classList.contains('show')) {
            document.querySelectorAll(`#${menuId} .model-dropdown-item`).forEach(item => {
                item.style.display = 'block';
            });
        }
    }
}

function selectSuiteModel(element, type) {
    const value = element.textContent;
    const inputId = type === 'gen' ? 'suiteGenModelInput' : 'suiteVLModelInput';
    const menuId = type === 'gen' ? 'suiteGenModelMenu' : 'suiteVLModelMenu';
    document.getElementById(inputId).value = value;
    
    document.querySelectorAll(`#${menuId} .model-dropdown-item`).forEach(item => {
        item.classList.remove('selected');
    });
    element.classList.add('selected');
    const menu = document.getElementById(menuId);
    menu.classList.remove('show');
    // 移动端：移除遮罩层
    toggleSuiteMobileBackdrop(false);
}

function filterSuiteModelOptions(type) {
    const inputId = type === 'gen' ? 'suiteGenModelInput' : 'suiteVLModelInput';
    const menuId = type === 'gen' ? 'suiteGenModelMenu' : 'suiteVLModelMenu';
    const input = document.getElementById(inputId).value.toLowerCase();
    const menu = document.getElementById(menuId);
    const items = document.querySelectorAll(`#${menuId} .model-dropdown-item`);
    
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        if (text.includes(input) || input === '') {
            item.style.display = 'block';
        } else {
            item.style.display = 'none';
        }
    });

    // 与常规模式一致：输入时自动展开下拉
    if (menu && !menu.classList.contains('show')) {
        menu.classList.add('show');
    }
}

// ==================== 关键词模板功能（V2 - 带标题） ====================
const TEMPLATE_STORAGE_KEY = 'banana_pro_templates_v2';
const TEMPLATE_LEGACY_KEY = 'banana_pro_templates'; // 旧版本key，用于迁移

// 默认模板数据（新格式：包含title和content）
const DEFAULT_TEMPLATES_V2 = [
    { title: '高质量细节', content: '高质量，8k分辨率，细节丰富' },
    { title: '赛博朋克', content: '赛博朋克风格，霓虹灯光' },
    { title: '水彩画风', content: '水彩画风格，柔和色彩' },
    { title: '动漫风格', content: '动漫风格，精美细节' },
    { title: '真实摄影', content: '照片级真实感，专业摄影' }
];

let currentEditIndex = -1; // -1表示添加新模式，>=0表示编辑模式

// 迁移旧版本数据（将纯文本数组转换为带标题的对象数组）
function migrateLegacyTemplates() {
    const legacyData = localStorage.getItem(TEMPLATE_LEGACY_KEY);
    if (!legacyData) return false;
    
    try {
        const legacyTemplates = JSON.parse(legacyData);
        if (Array.isArray(legacyTemplates) && legacyTemplates.length > 0) {
            // 检查是否已经是新格式
            if (typeof legacyTemplates[0] === 'object' && legacyTemplates[0].title) {
                return false; // 已经是新格式，不需要迁移
            }
            
            // 将旧格式转换为新格式
            const migrated = legacyTemplates.map((content, index) => ({
                title: `标题${index + 1}`,
                content: String(content || '')
            }));
            
            saveTemplates(migrated);
            debugLog('模板数据已迁移:', migrated.length, '条');
            
            // 可选：删除旧数据
            // localStorage.removeItem(TEMPLATE_LEGACY_KEY);
            return true;
        }
    } catch (e) {
        console.error('迁移旧模板失败:', e);
    }
    return false;
}

function loadTemplates() {
    const stored = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed;
            }
        } catch (e) {
            console.error('加载模板失败:', e);
        }
    }
    
    // 尝试迁移旧数据
    const migrated = migrateLegacyTemplates();
    if (migrated) {
        // 迁移后重新读取
        const migratedStored = localStorage.getItem(TEMPLATE_STORAGE_KEY);
        if (migratedStored) {
            try {
                return JSON.parse(migratedStored);
            } catch (e) {}
        }
    }
    
    // 如果没有数据，使用默认模板
    saveTemplates(DEFAULT_TEMPLATES_V2);
    return DEFAULT_TEMPLATES_V2;
}

function saveTemplates(templates) {
    localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
}

function renderTemplateList() {
    const templates = loadTemplates();
    const container = document.getElementById('templateList');
    
    if (templates.length === 0) {
        container.innerHTML = `
            <div class="template-empty">
                <i class="fas fa-inbox"></i>
                <p>暂无模板，点击上方按钮添加一个吧！</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = templates.map((template, index) => `
        <div class="template-row" data-index="${index}">
            <div class="template-title" onmouseenter="showTemplateTooltip(this)" onmouseleave="hideTemplateTooltip()">
                ${escapeHTML(template.title || '未命名')}
            </div>
            <div class="template-row-actions">
                <button class="template-row-btn edit" onclick="editTemplate(${index})">
                    <i class="fas fa-edit"></i> 编辑
                </button>
                <button class="template-row-btn apply" onclick="applyTemplate(${index})">
                    <i class="fas fa-check"></i> 应用
                </button>
                <button class="template-row-btn delete" onclick="deleteTemplate(${index})">
                    <i class="fas fa-trash"></i> 删除
                </button>
            </div>
        </div>
    `).join('');
    
    // 添加一个全局气泡元素
    if (!document.getElementById('globalTemplateTooltip')) {
        const tooltip = document.createElement('div');
        tooltip.id = 'globalTemplateTooltip';
        tooltip.className = 'template-tooltip';
        tooltip.innerHTML = '<div class="template-tooltip-content"></div>';
        document.body.appendChild(tooltip);
    }
}

// 显示模板气泡
function showTemplateTooltip(element) {
    const tooltip = document.getElementById('globalTemplateTooltip');
    const contentEl = tooltip.querySelector('.template-tooltip-content');
    const templates = loadTemplates();
    
    // 获取当前行的index
    const row = element.closest('.template-row');
    const index = parseInt(row.dataset.index);
    const template = templates[index];
    
    if (!template) return;
    
    // 设置内容
    contentEl.textContent = template.content || '';
    
    // 计算位置（显示在左边，紧贴模板弹窗边框）
    const rect = element.getBoundingClientRect();
    const modal = document.querySelector('.template-modal');
    const modalRect = modal ? modal.getBoundingClientRect() : { left: 0 };
    
    // 气泡显示在模板弹窗左边，距离15px
    let left = modalRect.left - 320 - 15;
    let top = rect.top + rect.height / 2 - 90; // 垂直居中（气泡高度180px）
    
    // 如果左边放不下（小于10px），显示在右边
    if (left < 10) {
        left = modalRect.right + 15;
    }
    
    // 顶部边界检测
    if (top < 10) {
        top = 10;
    }
    // 底部边界检测
    if (top + 180 > window.innerHeight - 10) {
        top = window.innerHeight - 190;
    }
    
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
    tooltip.style.transform = 'none';
    tooltip.classList.add('show');
}

// 隐藏模板气泡
function hideTemplateTooltip() {
    const tooltip = document.getElementById('globalTemplateTooltip');
    if (tooltip) {
        tooltip.classList.remove('show');
    }
}

function openTemplateModal() {
    document.getElementById('templateModalOverlay').classList.add('show');
    renderTemplateList();
}

function closeTemplateModal(event) {
    if (event && event.target !== document.getElementById('templateModalOverlay')) {
        return;
    }
    document.getElementById('templateModalOverlay').classList.remove('show');
}

// ==================== 模板编辑弹窗功能 ====================

function openTemplateEditModal(index = -1) {
    currentEditIndex = index;
    const overlay = document.getElementById('templateEditOverlay');
    const titleEl = document.getElementById('templateEditTitle');
    const titleInput = document.getElementById('templateEditTitleInput');
    const contentInput = document.getElementById('templateEditContentInput');
    
    if (index >= 0) {
        // 编辑模式
        const templates = loadTemplates();
        const template = templates[index];
        titleEl.innerHTML = '<i class="fas fa-edit"></i> 编辑模板';
        titleInput.value = template.title || '';
        contentInput.value = template.content || '';
    } else {
        // 添加模式
        titleEl.innerHTML = '<i class="fas fa-plus"></i> 添加模板';
        titleInput.value = '';
        contentInput.value = '';
    }
    
    overlay.classList.add('show');
    titleInput.focus();
}

function closeTemplateEditModal(event) {
    if (event && event.target !== document.getElementById('templateEditOverlay')) {
        return;
    }
    document.getElementById('templateEditOverlay').classList.remove('show');
    currentEditIndex = -1;
}

function saveTemplateEdit() {
    const titleInput = document.getElementById('templateEditTitleInput');
    const contentInput = document.getElementById('templateEditContentInput');
    
    const title = titleInput.value.trim();
    const content = contentInput.value.trim();
    
    if (!title) {
        alert('请输入模板标题');
        return;
    }
    if (!content) {
        alert('请输入关键词内容');
        return;
    }
    
    const templates = loadTemplates();
    
    if (currentEditIndex >= 0) {
        // 编辑模式：更新现有模板
        templates[currentEditIndex] = { title, content };
    } else {
        // 添加模式：检查是否已存在相同标题或内容
        const exists = templates.some(t => 
            t.title === title || t.content === content
        );
        if (exists) {
            alert('该模板标题或内容已存在');
            return;
        }
        templates.push({ title, content });
    }
    
    saveTemplates(templates);
    closeTemplateEditModal();
    renderTemplateList();
    
    showToast(currentEditIndex >= 0 ? '模板已更新' : '模板已添加');
}

function editTemplate(index) {
    openTemplateEditModal(index);
}

function deleteTemplate(index) {
    if (!confirm('确定删除这个模板吗？')) return;
    
    const templates = loadTemplates();
    templates.splice(index, 1);
    saveTemplates(templates);
    renderTemplateList();
    showToast('模板已删除');
}

function applyTemplate(index) {
    const templates = loadTemplates();
    const template = templates[index];
    
    if (!template) return;

    // 套图模式填入文案规则输入框，常规模式填入prompt
    const isSuitePage = document.getElementById('enhSuitePage')?.classList.contains('active');
    
    if (isSuitePage) {
        const suiteInput = document.getElementById('suiteCopyInput');
        if (suiteInput) {
            suiteInput.value = template.content;
            closeTemplateModal();
            suiteInput.focus();
            showToast(`已应用模板「${template.title}」到套图文案`);
            return;
        }
    }

    const promptInput = document.getElementById('prompt');
    
    // 直接覆盖输入框内容
    promptInput.value = template.content;
    
    promptInput.style.height = 'auto';
    promptInput.style.height = promptInput.scrollHeight + 'px';
    
    closeTemplateModal();
    promptInput.focus();
    
    showToast(`已应用模板「${template.title}」`);
}

// ==================== 拆分代码段 ====================

// 同步更新自定义下拉菜单 UI 状态的辅助函数
function syncCustomSelectUI(hiddenInputId, valueElementId, menuId) {
    const input = document.getElementById(hiddenInputId);
    if (!input) return;
    const value = input.value;
    
    // 1. 更新显示的 span 文本
    const valEl = document.getElementById(valueElementId);
    if (valEl) valEl.textContent = value;
    
    // 2. 更新选中项的 .selected 类名
    const menu = document.getElementById(menuId);
    if (menu) {
        menu.querySelectorAll('.custom-select-item').forEach(item => {
            if (item.textContent.trim() === value || item.getAttribute('onclick')?.includes("'" + value + "'")) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }
}

// 安全设置 select 元素/隐藏 input 的辅助函数
function safeSetSelect(selectEl, value, defaultValue) {
    if (!selectEl) return;
    
    // 如果是传统的 <select> 元素
    if (selectEl.tagName === 'SELECT') {
        const validValues = Array.from(selectEl.options).map(o => o.value);
        selectEl.value = (value && validValues.includes(value)) ? value : defaultValue;
        return;
    }
    
    // 如果是我们的隐藏 input 元素（用作自定义下拉菜单）
    selectEl.value = value || defaultValue;
    
    // 同步更新自定义下拉菜单的 UI 显示和选中态
    if (selectEl.id === 'suiteRatioInput') {
        syncCustomSelectUI('suiteRatioInput', 'suiteRatioValue', 'suiteRatioMenu');
    } else if (selectEl.id === 'suiteSizeInput') {
        syncCustomSelectUI('suiteSizeInput', 'suiteSizeValue', 'suiteSizeMenu');
    }
}

// ==================== 拆分代码段 ====================

(function () {
    const L = {
        regular: '\u5e38\u89c4',
        suite: '\u5957\u56fe',
        copyPlaceholder: '\u8f93\u5165\u6587\u6848\uff0c\u540e\u7eed\u56de\u4f20\u6587\u672c/\u56fe\u7247\u4f1a\u5bf9\u5e94\u586b\u5165\u5404\u81ea\u5361\u69fd',
        upload: '\u4e0a\u4f20\u56fe\u7247',
        count: '\u5361\u7247\u6570',
        ratio: '\u6bd4\u4f8b',
        size: '\u5c3a\u5bf8',
        build: '\u521b\u5efa\u5361\u69fd',
        wait: '\u7ed3\u679c\u4f1a\u663e\u793a\u5728\u8fd9\u91cc',
        textSlot: '\u53cd\u63a8\u6587\u672c\u5360\u4f4d',
        textHelp: '\u540e\u7eed\u56de\u4f20\u7684\u6587\u672c\u4f1a\u586b\u5728\u8fd9\u91cc',
        imageSlot: '\u7b49\u5f85\u4e2d',
        imageHelp: '\u540e\u7eed\u56de\u4f20\u7684\u56fe\u7247\u4f1a\u586b\u5728\u8fd9\u91cc',
        noRef: '\u672a\u4e0a\u4f20\u53c2\u8003\u56fe',
        createdPrefix: '\u5df2\u521b\u5efa ',
        createdSuffix: ' \u4e2a\u5361\u69fd'
    };

    window.suiteFiles = [];
    let currentSuiteHistoryId = null; // 当前套图模式的历史记录 ID（任务的实际ID）
    window.currentSuiteHistoryId = null;
    window.currentDisplayedSuiteHistoryId = null; // 当前正在展示的历史记录 ID（挂到window上供跨IIFE访问）
    window.currentSuiteHistoryReadOnly = false; // true=查看/复用来的，顶部集体操作时新建记录
    let activePage = 'regular';
    const suiteRunningStatusByHistory = new Map();
    const suiteRawResponseByHistory = new Map(); // historyId -> rawText

    function normalizeSuiteHistoryId(historyId) {
        if (historyId === undefined || historyId === null || historyId === '') return '';
        return String(historyId);
    }

    function getDisplayedSuiteHistoryId() {
        return window.currentDisplayedSuiteHistoryId ?? window.currentSuiteHistoryId ?? currentSuiteHistoryId;
    }

    function isSuiteHistoryDisplayed(historyId) {
        return normalizeSuiteHistoryId(getDisplayedSuiteHistoryId()) === normalizeSuiteHistoryId(historyId);
    }

    function setSuiteHistoryContext(historyId, readOnly = false) {
        const nextId = historyId === undefined || historyId === null || historyId === '' ? null : historyId;
        const prevId = normalizeSuiteHistoryId(getDisplayedSuiteHistoryId());
        const switching = prevId !== normalizeSuiteHistoryId(nextId);
        currentSuiteHistoryId = nextId;
        window.currentSuiteHistoryId = nextId;
        window.currentDisplayedSuiteHistoryId = nextId;
        window.currentSuiteHistoryReadOnly = readOnly;
        // 切换任务时恢复对应任务的原始回传，没有则隐藏
        if (switching) {
            const rawResponseDiv = document.getElementById('suiteRawResponse');
            const rawTextDiv = document.getElementById('suiteRawText');
            const savedRaw = nextId ? suiteRawResponseByHistory.get(String(nextId)) : null;
            if (rawResponseDiv && rawTextDiv) {
                if (savedRaw) {
                    rawTextDiv.textContent = savedRaw;
                    rawResponseDiv.style.display = 'block';
                } else {
                    rawResponseDiv.style.display = 'none';
                }
            }
        }
        renderSuiteRunningStatus();
    }

    function detachSuiteReadOnlyHistoryForNewWork() {
        const existingId = window.currentSuiteHistoryReadOnly ? getDisplayedSuiteHistoryId() : null;
        if (existingId) {
            setSuiteHistoryContext(null, false);
        }
        return existingId;
    }

    function setSuiteRunningStatus(historyId, taskId, type, message) {
        const key = normalizeSuiteHistoryId(historyId);
        if (!key) return;
        suiteRunningStatusByHistory.set(key, {
            taskId: String(taskId || ''),
            type,
            message,
            updatedAt: Date.now()
        });
        renderSuiteRunningStatus();
    }

    function clearSuiteRunningStatus(historyId, taskId) {
        const key = normalizeSuiteHistoryId(historyId);
        if (!key) return;
        const current = suiteRunningStatusByHistory.get(key);
        if (!current) return;
        if (taskId && current.taskId && current.taskId !== String(taskId)) return;
        suiteRunningStatusByHistory.delete(key);
        renderSuiteRunningStatus();
    }

    function renderSuiteRunningStatus() {
        const hint = document.getElementById('suiteHint');
        const statusBar = document.getElementById('suiteStatusBar');
        const statusBarText = document.getElementById('suiteStatusBarText');
        if (!hint) return false;
        const key = normalizeSuiteHistoryId(getDisplayedSuiteHistoryId());
        const status = key ? suiteRunningStatusByHistory.get(key) : null;
        if (status) {
            const msg = status.message || (status.type === 'keywords' ? '图片反推中...' : '图片生成中...');
            hint.textContent = msg;
            hint.style.color = '#f59e0b';
            hint.dataset.suiteStatusOwner = 'running';
            hint.dataset.suiteStatusHistoryId = key;
            hint.dataset.suiteStatusTaskId = status.taskId || '';
            if (statusBar && statusBarText) {
                statusBarText.textContent = msg;
                statusBar.style.display = 'flex';
            }
            return true;
        }
        if (hint.dataset.suiteStatusOwner === 'running') {
            hint.textContent = '';
            hint.style.color = '';
            delete hint.dataset.suiteStatusOwner;
            delete hint.dataset.suiteStatusHistoryId;
            delete hint.dataset.suiteStatusTaskId;
        }
        if (statusBar) statusBar.style.display = 'none';
        return false;
    }

    window.__suiteSetHistoryContext = setSuiteHistoryContext;
    window.__suiteSetRunningStatus = setSuiteRunningStatus;
    window.__suiteClearRunningStatus = clearSuiteRunningStatus;
    window.__suiteRenderRunningStatus = renderSuiteRunningStatus;
    window.__suiteRawResponseByHistory = suiteRawResponseByHistory;

    function ensureStyles() {
        if (document.getElementById('suite-enhance-style')) return;
        const style = document.createElement('style');
        style.id = 'suite-enhance-style';
        style.textContent = `
            .page-tabs-wrap { 
                display:inline-flex; 
                align-items:center; 
                gap:4px; 
                margin: 16px 0 12px 20px;
                padding: 0;
            }
            /* 对话模式：仅在桌面端左侧铺侧栏同色底，Tab 位置不变 */
            @media (min-width: 769px) {
                body.page-chat-active::before {
                    content: '';
                    position: fixed;
                    top: var(--navbar-height, 62px);
                    left: 0;
                    width: var(--chat-sidebar-w, 260px);
                    bottom: 0;
                    z-index: 1;
                    pointer-events: none;
                }
                [data-theme="light"] body.page-chat-active::before,
                html:not([data-theme="dark"]) body.page-chat-active::before {
                    background: var(--bg-body);
                }
                [data-theme="dark"] body.page-chat-active::before {
                    background: #1a1f2e;
                }
            }
            body.page-chat-active .page-tabs-wrap { position: relative; z-index: 2; }
            body.page-chat-active #enhChatPage { position: relative; z-index: 2; }
            body.page-chat-active #enhChatPage .chat-sidebar { position: relative; z-index: 2; }
            /* 套图模式checkbox样式 */
            .suite-mode-checkboxes {
                display: flex;
                gap: 12px;
                align-items: center;
            }
            .suite-mode-checkbox {
                display: flex;
                align-items: center;
                gap: 4px;
                cursor: pointer;
                font-size: 13px;
                color: var(--text-sub);
            }
            .suite-mode-checkbox input[type="checkbox"] {
                width: 16px;
                height: 16px;
                cursor: pointer;
                accent-color: var(--primary);
            }
            .suite-mode-checkbox input[type="checkbox"]:checked + span {
                color: var(--primary);
                font-weight: 600;
            }
            .page-tabs { display:inline-flex; gap:4px; background: var(--bg-card); border:1px solid var(--border); border-radius:10px; padding:4px; box-shadow: var(--shadow-sm); }
            .page-tab-btn { border:none; background:transparent; color:var(--text-sub); padding:7px 14px; border-radius:8px; cursor:pointer; font-size:13px; font-weight:600; }
            .page-tab-btn.active { background: linear-gradient(135deg, var(--primary), var(--primary-hover)); color:#fff; box-shadow:0 2px 6px rgba(99,102,241,.35); }
            .enh-page { display:none; flex:1; min-height:0; }
            .enh-page.active { display:flex; flex-direction:column; }

            /* ========== 对话模式样式（支持暗黑模式） ========== */
            .chat-shell { display:flex; flex:1; min-height:0; width:100%; background:var(--bg-card); }
            /* 左侧栏（布局共用，颜色分日间/夜间） */
            .chat-sidebar {
                width:var(--chat-sidebar-w, 260px);
                flex-shrink:0;
                display:flex;
                flex-direction:column;
                position:relative;
                height:100%;
                min-height:0;
                box-sizing:border-box;
                overflow:hidden;
            }
            [data-theme="light"] .chat-sidebar,
            html:not([data-theme="dark"]) .chat-sidebar {
                background:var(--bg-body);
                color:var(--text-main);
                border-right:1px solid var(--border);
            }
            [data-theme="dark"] .chat-sidebar {
                background:#1a1f2e;
                color:#e5e7eb;
                border-right:1px solid #2d3548;
            }
            .chat-sidebar-top { padding:16px; }
            .chat-new-btn { width:100%; padding:12px; border:none; border-radius:8px; background:linear-gradient(135deg,#f59e0b,#d97706); color:#fff; cursor:pointer; font-size:14px; display:flex; align-items:center; justify-content:center; gap:8px; transition:all .2s; box-shadow:0 2px 6px rgba(245,158,11,.35); font-weight:500; }
            .chat-new-btn:hover { transform:translateY(-1px); box-shadow:0 4px 12px rgba(245,158,11,.45); }
            .chat-sidebar-list { flex:1; overflow-y:auto; padding:0 16px; }
            .chat-history-item { display:flex; align-items:center; padding:10px 12px; margin-bottom:4px; border-radius:8px; cursor:pointer; gap:8px; transition:all .15s; color:inherit; width:100%; box-sizing:border-box; background:transparent; }
            [data-theme="light"] .chat-history-item,
            html:not([data-theme="dark"]) .chat-history-item {
                border:1px solid var(--border);
            }
            [data-theme="light"] .chat-history-item:hover,
            html:not([data-theme="dark"]) .chat-history-item:hover {
                background:var(--bg-hover);
                border-color:var(--border);
            }
            [data-theme="light"] .chat-history-item.active,
            html:not([data-theme="dark"]) .chat-history-item.active {
                background:#e5e7eb;
                color:var(--text-main);
                border-color:#d1d5db;
            }
            [data-theme="light"] .chat-history-item.active .chat-history-del,
            html:not([data-theme="dark"]) .chat-history-item.active .chat-history-del {
                color:var(--text-sub);
            }
            [data-theme="dark"] .chat-history-item { border:1px solid rgba(255,255,255,.08); }
            [data-theme="dark"] .chat-history-item:hover { background:rgba(255,255,255,.06); border-color:rgba(255,255,255,.16); }
            [data-theme="dark"] .chat-history-item.active { background:rgba(99,102,241,.32); border-color:rgba(129,140,248,.45); color:#fff; }
            .chat-history-item.active .chat-history-del { color:#fff; opacity:0.7; }
            .chat-history-item.active .chat-history-del:hover { opacity:1; }
            .chat-history-title { flex:1; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .chat-history-del { opacity:0; border:none; background:transparent; color:var(--text-sub); cursor:pointer; padding:4px; font-size:12px; border-radius:4px; transition:all .15s; }
            .chat-history-item:hover .chat-history-del { opacity:1; }
            .chat-history-del:hover { background:rgba(0,0,0,.1); color:#ef4444; }
            .chat-sidebar-bottom { padding:16px; }
            [data-theme="light"] .chat-sidebar-bottom,
            html:not([data-theme="dark"]) .chat-sidebar-bottom { border-top:1px solid var(--border); }
            [data-theme="dark"] .chat-sidebar-bottom { border-top:1px solid rgba(255,255,255,.08); }
            .chat-clear-btn { width:100%; padding:10px; border:none; border-radius:8px; background:transparent; cursor:pointer; font-size:13px; display:flex; align-items:center; justify-content:center; gap:6px; transition:all .2s; }
            [data-theme="light"] .chat-sidebar .chat-clear-btn,
            html:not([data-theme="dark"]) .chat-sidebar .chat-clear-btn { color:var(--text-sub); }
            [data-theme="dark"] .chat-sidebar .chat-clear-btn { color:#9ca3af; }
            .chat-clear-btn:hover { color:#ef4444; background:rgba(239,68,68,.08); }
            /* 右侧对话区 - 夜间深蓝黑 */
            .chat-main { flex:1; display:flex; flex-direction:column; min-width:0; background:var(--bg-card); }
            [data-theme="dark"] .chat-main { background:#0f172a; }
            /* 汉堡按钮：PC端隐藏，移动端在对话模式下显示 */
            .chat-menu-btn { display:none; }
            .chat-messages { flex:1; overflow-y:auto; padding:24px 0; display:flex; flex-direction:column; gap:24px; }
            .chat-messages-inner { width:70%; margin:0 auto; display:flex; flex-direction:column; gap:24px; }
            .chat-welcome { text-align:center; margin:auto; color:var(--text-sub); padding:40px 20px; }
            .chat-welcome p { font-size:16px; }
            /* 消息气泡：用户右对齐，AI 左对齐 */
            .chat-msg { display:flex; width:100%; }
            .chat-msg.user { justify-content:flex-end; }
            .chat-msg.ai { justify-content:flex-start; }
            .chat-msg-content { display:flex; flex-direction:column; gap:6px; max-width:70%; }
            .chat-msg.user .chat-msg-content { align-items:flex-end; margin-left:auto; }
            .chat-msg.ai .chat-msg-content { align-items:flex-start; margin-right:auto; }
            .chat-msg-time { font-size:11px; color:rgba(148,163,184,0.7); margin-bottom:2px; white-space:nowrap; }
            .chat-msg.user .chat-msg-time { text-align:right; margin-right:10px; }
            .chat-msg-bubble { padding:12px 16px; border-radius:12px; font-size:15px; line-height:1.7; max-width:100%; }
            .chat-msg-bubble:has(.chat-msg-bubble-images):not(:has(.chat-msg-bubble-text)) { padding:8px; }
            .chat-msg-bubble-text { white-space:pre-wrap; word-break:normal; overflow-wrap:break-word; }
            .chat-msg-bubble-images + .chat-msg-bubble-text { margin-top:8px; }
            .chat-msg-bubble-images { display:flex; flex-wrap:wrap; gap:8px; max-width:100%; }
            .chat-msg-bubble-images.single { flex-wrap:wrap; }
            .chat-msg-bubble-images.multi { flex-wrap:wrap; }
            /* 根据图片比例调整每行数量：超宽(21:9)2张，横版(16:9)3张，微横(4:3)4张，正方(1:1)6张，微竖(3:4)6张，竖版(9:16)8张 */
            .chat-bubble-img { height:144px; width:auto; flex-shrink:0; border-radius:6px; cursor:pointer; object-fit:cover; transition:transform .15s; border:1px solid rgba(255,255,255,.25); }
            .chat-bubble-img-placeholder { display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg, rgba(100,116,139,.15), rgba(100,116,139,.08)); border:1px dashed rgba(100,116,139,.4); cursor:default; }
            .chat-bubble-img-placeholder .chat-placeholder-text { font-size:13px; color:#64748b; text-align:center; }
            .chat-bubble-img-failed { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; padding:8px; box-sizing:border-box; background:rgba(239,68,68,.15); border:2px solid rgba(239,68,68,.6); cursor:default; overflow:hidden; }
            .chat-bubble-img-failed::before { content:'❌'; font-size:24px; line-height:1; color:#ef4444; }
            .chat-bubble-img-failed .chat-placeholder-text { font-size:13px; color:#ef4444; font-weight:600; }
            .chat-bubble-img-failed .chat-failed-reason { max-width:100%; font-size:11px; line-height:1.3; color:#b91c1c; text-align:center; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; word-break:break-word; }
            .chat-bubble-img:hover { transform:scale(1.05); }
            .chat-msg-bubble-meta { margin-top:8px; font-size:12px; line-height:1.5; color:inherit; opacity:.82; padding-top:8px; border-top:1px solid rgba(255,255,255,.12); word-break:break-word; }
            [data-theme="light"] .chat-msg.user .chat-msg-bubble-meta,
            html:not([data-theme="dark"]) .chat-msg.user .chat-msg-bubble-meta { border-top-color:rgba(15,23,42,.10); }
            [data-theme="light"] .chat-msg.ai .chat-msg-bubble-meta,
            html:not([data-theme="dark"]) .chat-msg.ai .chat-msg-bubble-meta { border-top-color:rgba(255,255,255,.18); }
            /* 日间：侧栏/用户气泡与页面浅灰底同色；AI 蓝紫。夜间另套 */
            [data-theme="light"] .chat-msg.user .chat-msg-bubble,
            html:not([data-theme="dark"]) .chat-msg.user .chat-msg-bubble {
                background:var(--bg-body);
                color:var(--text-main);
                border:1px solid var(--border);
                border-bottom-right-radius:4px;
                box-shadow:none;
            }
            [data-theme="light"] .chat-msg.ai .chat-msg-bubble,
            html:not([data-theme="dark"]) .chat-msg.ai .chat-msg-bubble {
                background:linear-gradient(135deg,#6366f1,#4f46e5);
                color:#fff;
                border:none;
                border-bottom-left-radius:4px;
                box-shadow:0 2px 8px rgba(99,102,241,.28);
            }
            [data-theme="dark"] .chat-msg.user .chat-msg-bubble {
                background:linear-gradient(160deg,#3a4460 0%,#2d3548 100%);
                color:#e8eaf6;
                border:1px solid rgba(255,255,255,.07);
                border-bottom-right-radius:4px;
                box-shadow:none;
            }
            [data-theme="dark"] .chat-msg.ai .chat-msg-bubble {
                background:#1e293b;
                border:1px solid #334155;
                color:#f1f5f9;
                border-bottom-left-radius:4px;
                box-shadow:none;
            }
            [data-theme="light"] .chat-msg.ai .chat-bubble-img,
            html:not([data-theme="dark"]) .chat-msg.ai .chat-bubble-img { border-color:rgba(255,255,255,.28); }
            [data-theme="dark"] .chat-msg.ai .chat-bubble-img { border-color:#475569; }
            [data-theme="light"] .chat-msg.user .chat-bubble-img,
            html:not([data-theme="dark"]) .chat-msg.user .chat-bubble-img { border-color:var(--border); }
            .chat-msg-actions { display:flex; gap:8px; margin-top:8px; padding:0 4px; flex-wrap:wrap; }
            .chat-msg.user .chat-msg-actions { justify-content:flex-end; }
            .chat-msg.ai .chat-msg-actions { justify-content:flex-start; }
            .chat-msg.pending .chat-msg-bubble { opacity:0.85; }
            .chat-msg.error .chat-msg-bubble { border:1px solid #fca5a5 !important; background:rgba(254,226,226,.5) !important; color:#b91c1c !important; }
            [data-theme="dark"] .chat-msg.error .chat-msg-bubble { background:rgba(127,29,29,.35) !important; border-color:#f87171 !important; color:#fecaca !important; }
            .chat-msg-thinking { display:flex; align-items:center; gap:8px; color:var(--text-sub); }
            .chat-thinking-dot { width:8px; height:8px; border-radius:50%; background:var(--primary); animation:chat-pulse 1s ease-in-out infinite; }
            @keyframes chat-pulse { 0%,100%{ opacity:.35; transform:scale(.9); } 50%{ opacity:1; transform:scale(1); } }
            /* 流式打字机光标 */
            .stream-cursor { display:inline-block; width:2px; height:1.1em; background:var(--primary); margin-left:2px; vertical-align:text-bottom; animation:stream-blink .8s step-end infinite; }
            @keyframes stream-blink { 0%,100%{ opacity:1; } 50%{ opacity:0; } }
            .chat-msg-action-btn { border:none; background:transparent; color:var(--text-sub); cursor:pointer; font-size:12px; padding:4px 8px; border-radius:6px; display:flex; align-items:center; gap:4px; transition:all .15s; }
            .chat-msg-action-btn:hover { background:var(--bg-hover, #f3f4f6); color:var(--primary); }
            [data-theme="dark"] .chat-msg-action-btn:hover { background:#374151; }
            /* 消息折叠/展开按钮 */
            .chat-collapse-btn { position:absolute; top:8px; right:8px; width:28px; height:28px; border:none; border-radius:6px; background:rgba(0,0,0,.15); color:rgba(255,255,255,.8); cursor:pointer; font-size:12px; display:flex; align-items:center; justify-content:center; transition:all .2s; z-index:2; opacity:0; }
            .chat-msg-bubble:hover .chat-collapse-btn { opacity:1; }
            .chat-collapse-btn:hover { background:rgba(0,0,0,.3); color:#fff; }
            [data-theme="light"] .chat-collapse-btn,
            html:not([data-theme="dark"]) .chat-collapse-btn { background:rgba(0,0,0,.08); color:rgba(0,0,0,.5); }
            [data-theme="light"] .chat-collapse-btn:hover,
            html:not([data-theme="dark"]) .chat-collapse-btn:hover { background:rgba(0,0,0,.15); color:rgba(0,0,0,.8); }
            [data-theme="light"] .chat-msg.ai .chat-collapse-btn,
            html:not([data-theme="dark"]) .chat-msg.ai .chat-collapse-btn { background:rgba(255,255,255,.2); color:rgba(255,255,255,.8); }
            [data-theme="light"] .chat-msg.ai .chat-collapse-btn:hover,
            html:not([data-theme="dark"]) .chat-msg.ai .chat-collapse-btn:hover { background:rgba(255,255,255,.35); color:#fff; }
            /* 生图开关样式 */
            .chat-toggle-row { display:flex; align-items:center; padding:4px 0; }
            .chat-toggle-label { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }
            .chat-toggle-label input[type="checkbox"] { display:none; }
            .chat-toggle-switch { position:relative; width:36px; height:20px; background:#d1d5db; border-radius:10px; transition:background .2s; }
            .chat-toggle-switch::after { content:''; position:absolute; top:2px; left:2px; width:16px; height:16px; background:#fff; border-radius:50%; transition:transform .2s; }
            .chat-toggle-label input:checked + .chat-toggle-switch { background:#6366f1; }
            .chat-toggle-label input:checked + .chat-toggle-switch::after { transform:translateX(16px); }
            .chat-toggle-text { font-size:13px; color:var(--text-main, #1e293b); }
            [data-theme="dark"] .chat-toggle-text { color:#e2e8f0; }
            [data-theme="dark"] .chat-toggle-switch { background:#4b5563; }
            [data-theme="dark"] .chat-toggle-label input:checked + .chat-toggle-switch { background:#818cf8; }
            /* 折叠状态 */
            .chat-msg-bubble.collapsed .chat-msg-bubble-text { max-height:calc(1.7em * 3); overflow:hidden; position:relative; }
            .chat-msg-bubble.collapsed .chat-msg-bubble-text::after { content:''; position:absolute; bottom:0; left:0; right:0; height:40px; background:linear-gradient(transparent, var(--bubble-bg, #6366f1)); pointer-events:none; }
            .chat-msg.user .chat-msg-bubble.collapsed .chat-msg-bubble-text::after { --bubble-bg: var(--bg-body); }
            [data-theme="light"] .chat-msg.ai .chat-msg-bubble.collapsed .chat-msg-bubble-text::after,
            html:not([data-theme="dark"]) .chat-msg.ai .chat-msg-bubble.collapsed .chat-msg-bubble-text::after { --bubble-bg: #6366f1; }
            [data-theme="dark"] .chat-msg.ai .chat-msg-bubble.collapsed .chat-msg-bubble-text::after { --bubble-bg: #1e293b; }
            .chat-msg-bubble.collapsed .chat-msg-bubble-images { display:none; }
            .chat-msg-bubble.collapsed .chat-msg-bubble-meta { display:none; }
            /* 输入区 - 无上边框，上移，蓝色发光一直显示 */
            .chat-input-area { padding:12px 0 20px; background:var(--bg-card); margin-top:-8px; display:flex; justify-content:center; }
            [data-theme="dark"] .chat-input-area { background:#0f172a; }
            .chat-input-box { width:70%; border:1px solid var(--primary); border-radius:12px; padding:12px 16px; background:var(--bg-card); box-shadow:0 0 0 3px rgba(99,102,241,.2), 0 0 20px rgba(99,102,241,.15); }
            .chat-input-tools { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
            .chat-tool-btn { width:32px; height:32px; border:none; border-radius:6px; background:transparent; color:var(--text-sub); cursor:pointer; font-size:14px; display:flex; align-items:center; justify-content:center; transition:all .15s; }
            .chat-tool-btn:hover { background:var(--bg-hover, #f3f4f6); color:var(--primary); }
            .chat-model-select { display:flex; align-items:center; gap:6px; font-size:13px; color:var(--text-sub); }
            .chat-model-label { white-space:nowrap; }
            .chat-model-dropdown { border:1px solid var(--border); border-radius:6px; padding:4px 10px; font-size:13px; background:var(--bg-card); color:var(--text-main); cursor:pointer; outline:none; transition:all .15s; min-width:230px; height:32px; }
            .chat-model-dropdown:hover { border-color:var(--primary); }
            .chat-model-dropdown:focus { border-color:var(--primary); }
            .chat-quick-selects { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
            .chat-quick-select { display:flex; align-items:center; gap:6px; font-size:13px; color:var(--text-sub); }
            .chat-quick-select .custom-select-wrapper { min-width:0; flex:0 0 auto; }
            .chat-quick-select .custom-select-btn { height:32px; border-radius:8px; width:max-content; min-width:0; }
            .chat-quick-select .custom-select-menu { width:max-content; min-width:100%; left:0; right:auto; }
            .chat-quick-select .custom-select-item { white-space:nowrap; }
            .chat-model-select.chat-quick-select { max-width:100%; }
            /* 对话模型：按最长选项 Qwen/Qwen3.5-397B-A17B 自适应 + 20px留白 */
            .chat-model-select.chat-quick-select[data-kind="chat-model"] .custom-select-wrapper { width:auto; min-width:200px; }
            /* 生图模型：按最长选项 nano-banana-pro-4k-vip 自适应 + 20px留白 */
            .chat-model-select.chat-quick-select[data-kind="chat-image-model"] .custom-select-wrapper { width:auto; min-width:180px; }
            /* 比例：按最长选项 16:9（宽屏横向）自适应 + 20px留白 */
            .chat-model-select.chat-quick-select[data-kind="chat-ratio"] .custom-select-wrapper { width:auto; min-width:130px; }
            /* 尺寸：1K/2K/4K 很短 */
            .chat-model-select.chat-quick-select[data-kind="chat-size"] .custom-select-wrapper { width:auto; min-width:60px; }
            .chat-model-select.chat-quick-select .custom-select-btn { width:100%; justify-content:space-between; }
            .chat-model-select.chat-quick-select .custom-select-menu { width:max-content; min-width:100%; }
            .chat-model-select.chat-quick-select[data-kind="chat-model"] .custom-select-value,
            .chat-model-select.chat-quick-select[data-kind="chat-image-model"] .custom-select-value,
            .chat-model-select.chat-quick-select[data-kind="chat-ratio"] .custom-select-value,
            .chat-model-select.chat-quick-select[data-kind="chat-size"] .custom-select-value { color:#e5e7eb; }
            .chat-model-select.chat-quick-select[data-kind="chat-model"] .custom-select-item.selected,
            .chat-model-select.chat-quick-select[data-kind="chat-image-model"] .custom-select-item.selected,
            .chat-model-select.chat-quick-select[data-kind="chat-ratio"] .custom-select-item.selected,
            .chat-model-select.chat-quick-select[data-kind="chat-size"] .custom-select-item.selected { background: var(--primary); color:#fff !important; font-weight:600; }
            .chat-input-row { display:flex; gap:12px; align-items:flex-end; }
            .chat-input-content { flex:1; display:flex; flex-direction:column; gap:8px; }
            .chat-images-preview { display:none; flex-wrap:wrap; gap:8px; padding:8px 0; }
            .chat-images-preview.has-images { display:flex; }
            .chat-image-thumb { position:relative; width:60px; height:60px; flex-shrink:0; border-radius:8px; overflow:hidden; border:1px solid var(--border); transition:transform .2s, box-shadow .2s; touch-action:none; user-select:none; cursor:grab; }
            .chat-image-thumb.dragging { opacity:0.5; transform:scale(1.1); box-shadow:0 8px 16px rgba(0,0,0,.2); z-index:100; cursor:grabbing; }
            .chat-image-thumb.chat-drag-over { transform:scale(1.05); box-shadow:0 0 0 2px var(--primary); z-index:99; }
            .chat-image-thumb img { width:100%; height:100%; object-fit:cover; }
            .chat-image-thumb .chat-image-label { position:absolute; top:2px; left:2px; padding:2px 4px; border-radius:3px; background:rgba(99,102,241,.9); color:#fff; font-size:10px; font-weight:bold; pointer-events:none; }
            .chat-image-thumb .chat-image-remove { position:absolute; top:0; right:0; width:18px; height:18px; background:rgba(0,0,0,.5); color:#fff; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:10px; z-index:10; opacity:0; transition:opacity .15s; }
            .chat-image-thumb:hover .chat-image-remove { opacity:1; }
            .chat-input-row textarea { width:100%; border:none; padding:8px 0; font-size:15px; resize:none; min-height:24px; max-height:192px; background:transparent; color:var(--text-main); outline:none; font-family:inherit; line-height:1.6; overflow-y:auto; box-sizing:border-box; }
            .chat-input-row textarea::placeholder { color:var(--text-sub); }
            .chat-send-btn { width:36px; height:36px; border:none; border-radius:8px; background:linear-gradient(135deg,var(--primary),var(--primary-hover)); color:#fff; cursor:pointer; font-size:14px; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:all .15s; }
            .chat-send-btn:hover { transform:scale(1.05); box-shadow:0 4px 12px rgba(99,102,241,.4); }
            .chat-send-btn:disabled { background:var(--border); cursor:not-allowed; transform:none; box-shadow:none; }
            .suite-shell { flex:1; min-height:0; max-width:1200px; width:100%; margin:0 auto; padding:16px 20px 20px; display:flex; flex-direction:column; gap:14px; }
            .suite-raw-panel { display:none; }
            .suite-composer { background:var(--bg-card); border:1px solid var(--border); border-radius:16px; box-shadow:var(--shadow-md); padding:14px; display:flex; flex-direction:column; gap:12px; position:relative; z-index:50; }
            .suite-collapse-toggle { display: none; }
            .suite-composer.drag-over { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(99,102,241,.15); }
            .suite-row { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
            .suite-composer .suite-row { position: relative; z-index: 20; }
            .suite-composer .model-dropdown-wrapper { position: relative; z-index: 30; }
            .suite-composer .model-dropdown-menu { z-index: 3100 !important; }
            #suiteVLModelMenu { 
                z-index: 3200 !important;
                top: 100% !important;
                bottom: auto !important;
                margin-top: 4px !important;
            }
            @media (max-width: 768px) {
                .suite-composer .model-dropdown-menu {
                    position: fixed !important;
                    top: 50% !important;
                    left: 50% !important;
                    right: auto !important;
                    bottom: auto !important;
                    transform: translate(-50%, -50%) !important;
                    width: 78% !important;
                    max-height: 55vh !important;
                    z-index: 9999 !important;
                    border-radius: 14px !important;
                    box-shadow: 0 8px 32px rgba(0,0,0,.3) !important;
                    margin-top: 0 !important;
                }
                #suiteVLModelMenu {
                    top: 50% !important;
                    bottom: auto !important;
                    z-index: 9999 !important;
                    margin-top: 0 !important;
                }
            }
            .suite-copy { width:100%; min-height:88px; resize:vertical; border:1px solid var(--border); border-radius:10px; background:var(--bg-input); color:var(--text-main); padding:10px 12px; font-size:14px; line-height:1.5; }
            .suite-copy:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(99,102,241,.15); }
            .suite-count-wrap { display:flex; align-items:center; gap:8px; border:1px solid var(--border); border-radius:8px; padding:6px 10px; color:var(--text-sub); font-size:13px; }
            .suite-count-input { width:76px; border:none; background:transparent; color:var(--text-main); text-align:center; font-size:14px; }
            .suite-preview-row { display:none; gap:10px; overflow-x:auto; padding-bottom:2px; }
            .suite-preview-row.has-items { display:flex; }
            .suite-scroll { flex:1; min-height:0; overflow-y:auto; padding-right:4px; }
            .suite-grid { --suite-min:260px; display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:14px; align-items:start; padding-bottom:20px; }
            .suite-grid[data-columns='3'] { grid-template-columns:repeat(3, minmax(0, 1fr)); }
            .suite-grid[data-columns='2'] { grid-template-columns:repeat(2, minmax(0, 1fr)); }
            .suite-grid[data-columns='1'] { grid-template-columns:repeat(1, minmax(0, 1fr)); }
            .suite-empty { grid-column:1 / -1; text-align:center; color:var(--text-sub); padding:42px 8px; font-size:14px; }
            .suite-empty i { font-size:28px; margin-bottom:8px; opacity:.6; }
            .suite-card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:10px; box-shadow:var(--shadow-sm); display:flex; flex-direction:column; gap:8px; }
            .suite-card-head { display:flex; justify-content:space-between; align-items:center; gap:8px; color:var(--text-sub); font-size:12px; }
            .suite-chip { display:inline-flex; align-items:center; border:1px solid var(--border); border-radius:999px; background:var(--bg-hover); color:var(--text-main); padding:2px 8px; font-weight:600; }
            .suite-card-content { position:relative; width:100%; aspect-ratio: var(--slot-ratio, 1 / 1); min-height:180px; }
            .suite-text-area { display:none; width:100%; height:100%; max-height:none; resize:none; border:1px solid var(--border); border-radius:8px; background:var(--bg-input); color:var(--text-main); padding:10px; font-size:13px; line-height:1.5; box-sizing:border-box; position:absolute; top:0; left:0; }
            .suite-text-area:focus { border-color:var(--primary); box-shadow:0 0 0 3px rgba(99,102,241,.15); outline:none; }
            .suite-image-slot { display:none; position:absolute; top:0; left:0; width:100%; height:100%; border:1px dashed var(--border); border-radius:10px; background:var(--bg-input); color:var(--text-sub); align-items:center; justify-content:center; text-align:center; padding:10px; box-sizing:border-box; }
            .suite-meta { font-size:12px; color:var(--text-sub); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            /* 切换显示逻辑 */
            .suite-view-text .suite-text-area { display:block; }
            .suite-view-text .suite-image-slot { display:none !important; }
            .suite-view-image .suite-text-area { display:none !important; }
            .suite-view-image .suite-image-slot { display:flex; }
            .suite-tab-btn { padding:4px 10px; border:1px solid var(--border); border-radius:6px; background:#374151; color:#9ca3af; font-size:11px; font-weight:600; cursor:pointer; transition:all .2s; }
            .suite-tab-text.active { background:#6366f1 !important; color:#fff !important; border-color:#6366f1 !important; }
            .suite-tab-image.active { background:#10b981 !important; color:#fff !important; border-color:#10b981 !important; }
            .suite-card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
            .suite-text-area { display:block; }
            .suite-image-slot { display:none; }
            .suite-view-text .suite-text-area { display:block; }
            .suite-view-text .suite-image-slot { display:none; }
            .suite-view-image .suite-text-area { display:none; }
            .suite-view-image .suite-image-slot { display:flex; }
        `;
        document.head.appendChild(style);
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    function parseRatioText(ratioText) {
        if (!ratioText || ratioText === 'auto') return [1, 1];
        const pair = ratioText.split(':');
        const w = parseFloat(pair[0]);
        const h = parseFloat(pair[1]);
        if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return [1, 1];
        return [w, h];
    }

    function fallbackResolution(imageSize, ratioText) {
        const baseMap = { '1K': 1024, '2K': 2048, '4K': 4096 };
        const base = baseMap[imageSize] || 1024;
        const ratio = parseRatioText(ratioText);
        if (ratioText === 'auto') return { width: base, height: base };
        return { width: Math.round(base * ratio[0] / ratio[1]), height: base };
    }

    function getTargetResolution(size, ratio) {
        if (typeof window.calculateTargetResolution === 'function') {
            try {
                return window.calculateTargetResolution(size, ratio);
            } catch (_) {}
        }
        return fallbackResolution(size, ratio);
    }

    function syncChatLayoutMetrics() {
        const nav = document.querySelector('.navbar');
        if (nav) {
            document.documentElement.style.setProperty('--navbar-height', nav.offsetHeight + 'px');
        }
    }

    function switchPage(page) {
        const regular = document.getElementById('enhRegularPage');
        const suite = document.getElementById('enhSuitePage');
        const chat = document.getElementById('enhChatPage');
        const btnRegular = document.getElementById('pageTabRegular');
        const btnSuite = document.getElementById('pageTabSuite');
        const btnChat = document.getElementById('pageTabChat');
        if (!regular || !suite || !chat || !btnRegular || !btnSuite || !btnChat) return;

        activePage = page;
        regular.classList.toggle('active', activePage === 'regular');
        suite.classList.toggle('active', activePage === 'suite');
        chat.classList.toggle('active', activePage === 'chat');
        btnRegular.classList.toggle('active', activePage === 'regular');
        btnSuite.classList.toggle('active', activePage === 'suite');
        btnChat.classList.toggle('active', activePage === 'chat');
        document.body.classList.toggle('page-chat-active', activePage === 'chat');

        if (activePage === 'chat') {
            syncChatLayoutMetrics();
            // 切换到对话模式时，确保数据已加载
            if (chatConversations.length === 0) {
            loadChatDataOnInit().catch((err) => debugWarn('对话数据加载失败:', err));
            } else {
                renderChatList();
                renderChatMessages();
            }
        }

        if (activePage === 'suite') {
            document.getElementById('historyDrawer')?.classList.remove('open');
            document.getElementById('drawerOverlay')?.classList.remove('open');
            renderSuiteRunningStatus();
        }
    }

    function switchCardTab(btn, type) {
        const card = btn.closest('.suite-card');
        if (!card) return;
        card.classList.remove('suite-view-text', 'suite-view-image');
        card.classList.add(type === 'text' ? 'suite-view-text' : 'suite-view-image');
        card.querySelectorAll('.suite-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    }

    // 事件委托处理卡片切换
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('suite-tab-btn')) {
            const type = e.target.dataset.type;
            if (type) {
                switchCardTab(e.target, type);
            }
        }
    });

    function updateSuiteGridDensity() {
        const ratioSel = document.getElementById('suiteRatioInput');
        const grid = document.getElementById('suiteSlotGrid');
        if (!ratioSel || !grid) return;

        const ratio = ratioSel.value;
        let min = 220;
        if (ratio === '16:9' || ratio === '21:9') min = 320;
        else if (ratio === '3:2' || ratio === '4:3' || ratio === '5:4') min = 270;
        else if (ratio === '3:4' || ratio === '4:5' || ratio === '9:16' || ratio === '2:3') min = 190;
        grid.style.setProperty('--suite-min', `${min}px`);
    }

    let suiteDraggedThumbIndex = null;
    let suiteDragLongPressTimer = null;
    let suiteIsDragging = false;
    let suitePreviewRenderToken = 0;

    function renderSuitePreviews() {
        const renderToken = ++suitePreviewRenderToken;
        const row = document.getElementById('suitePreviewRow');
        if (!row) return;
        row.innerHTML = '';
        if (window.suiteFiles.length === 0) {
            row.classList.remove('has-items');
            return;
        }
        row.classList.add('has-items');

        window.suiteFiles.forEach((file, idx) => {
            const item = document.createElement('div');
            item.className = 'thumb-item';
            item.dataset.index = String(idx);
            item.style.cursor = 'grab';
            item.addEventListener('mousedown', (e) => startSuiteDrag(e, idx));
            item.addEventListener('touchstart', (e) => startSuiteDrag(e, idx), { passive: false });
            item.addEventListener('dragstart', (e) => e.preventDefault());
            item.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:12px;color:#9ca3af;">...</div>';
            row.appendChild(item);

            const reader = new FileReader();
            reader.onload = (ev) => {
                if (renderToken !== suitePreviewRenderToken) return;
                const src = ev.target.result;
                item.innerHTML = `<img src="${src}" draggable="false" style="cursor:zoom-in;" onclick="openPreviewFromUrl('${src.replace(/'/g, "\\'")}', '参考图 ${idx + 1}');event.stopPropagation();"><div style="position:absolute;top:2px;left:2px;background:rgba(99,102,241,0.92);color:#fff;font-size:10px;font-weight:700;padding:2px 4px;border-radius:3px;pointer-events:none;">图${idx + 1}</div><button class="thumb-remove" onclick="window.__suiteRemoveFile(${idx});event.stopPropagation();"><i class="fas fa-times"></i></button>`;
                item.style.position = 'relative';
            };
            reader.readAsDataURL(file);
        });
    }

    function startSuiteDrag(e, index) {
        if (suiteIsDragging) return;
        const isTouch = e.type === 'touchstart';
        if (suiteDragLongPressTimer) clearTimeout(suiteDragLongPressTimer);
        suiteDragLongPressTimer = setTimeout(() => {
            suiteIsDragging = true;
            suiteDraggedThumbIndex = index;
            document.querySelectorAll('#suitePreviewRow .thumb-item').forEach(item => {
                if (parseInt(item.dataset.index, 10) === index) item.classList.add('dragging');
            });
            if (isTouch) {
                document.addEventListener('touchmove', handleSuiteDragMove, { passive: false });
                document.addEventListener('touchend', handleSuiteDragEnd);
            } else {
                document.addEventListener('mousemove', handleSuiteDragMove);
                document.addEventListener('mouseup', handleSuiteDragEnd);
            }
        }, 200);

        const cancel = () => {
            if (suiteDragLongPressTimer) {
                clearTimeout(suiteDragLongPressTimer);
                suiteDragLongPressTimer = null;
            }
        };
        if (isTouch) document.addEventListener('touchend', cancel, { once: true });
        else document.addEventListener('mouseup', cancel, { once: true });
    }

    function handleSuiteDragMove(e) {
        if (!suiteIsDragging || suiteDraggedThumbIndex === null) return;
        e.preventDefault();
        const isTouch = e.type === 'touchmove';
        const clientX = isTouch ? e.touches[0].clientX : e.clientX;
        const clientY = isTouch ? e.touches[0].clientY : e.clientY;
        document.querySelectorAll('#suitePreviewRow .thumb-item').forEach(item => {
            const itemIndex = parseInt(item.dataset.index, 10);
            if (itemIndex === suiteDraggedThumbIndex) return;
            const rect = item.getBoundingClientRect();
            const over = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
            item.classList.toggle('drag-over', over);
        });
    }

    function handleSuiteDragEnd(e) {
        if (suiteDragLongPressTimer) {
            clearTimeout(suiteDragLongPressTimer);
            suiteDragLongPressTimer = null;
        }
        if (!suiteIsDragging || suiteDraggedThumbIndex === null) {
            document.removeEventListener('mousemove', handleSuiteDragMove);
            document.removeEventListener('mouseup', handleSuiteDragEnd);
            document.removeEventListener('touchmove', handleSuiteDragMove);
            document.removeEventListener('touchend', handleSuiteDragEnd);
            return;
        }

        const isTouch = e.type === 'touchend';
        const clientX = isTouch ? e.changedTouches[0].clientX : e.clientX;
        const clientY = isTouch ? e.changedTouches[0].clientY : e.clientY;
        let targetIndex = null;

        document.querySelectorAll('#suitePreviewRow .thumb-item').forEach(item => {
            item.classList.remove('dragging', 'drag-over');
            item.style.cursor = 'grab';
            const itemIndex = parseInt(item.dataset.index, 10);
            if (itemIndex === suiteDraggedThumbIndex) return;
            const rect = item.getBoundingClientRect();
            if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
                targetIndex = itemIndex;
            }
        });

        if (targetIndex !== null && targetIndex !== suiteDraggedThumbIndex) {
            const temp = window.suiteFiles[suiteDraggedThumbIndex];
            window.suiteFiles.splice(suiteDraggedThumbIndex, 1);
            window.suiteFiles.splice(targetIndex, 0, temp);
            renderSuitePreviews();
            showToast('图片顺序已调整');
        }

        suiteIsDragging = false;
        suiteDraggedThumbIndex = null;
        suiteDragLongPressTimer = null;
        document.removeEventListener('mousemove', handleSuiteDragMove);
        document.removeEventListener('mouseup', handleSuiteDragEnd);
        document.removeEventListener('touchmove', handleSuiteDragMove);
        document.removeEventListener('touchend', handleSuiteDragEnd);
    }

    function restoreSuiteFilesFromHistory(item) {
        if (item && (!Array.isArray(item.fileData) || item.fileData.length === 0) && item.firstImage) {
            item.fileData = [{ data: item.firstImage, name: 'suite_ref_1.png', type: 'image/png' }];
        }
        if (!item || !Array.isArray(item.fileData) || item.fileData.length === 0) {
            window.suiteFiles = [];
            renderSuitePreviews();
            return Promise.resolve([]);
        }
        return Promise.all(item.fileData.map((entry, idx) => {
            return new Promise((resolve) => {
                const raw = (entry && typeof entry === 'object') ? (entry.data || '') : String(entry || '');
                const matches = raw.match(/^data:([^;]+);base64,(.+)$/);
                if (!matches) {
                    resolve(null);
                    return;
                }
                try {
                    const mimeType = matches[1];
                    const base64Data = matches[2];
                    const binary = atob(base64Data);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    const blob = new Blob([bytes], { type: mimeType });
                    const ext = mimeType.split('/')[1] || 'png';
                    const fileName = (entry && entry.name) ? entry.name : `suite_ref_${idx + 1}.${ext}`;
                    resolve(new File([blob], fileName, { type: mimeType }));
                } catch (_) {
                    resolve(null);
                }
            });
        })).then((files) => {
            window.suiteFiles = files.filter(Boolean);
            renderSuitePreviews();
            return window.suiteFiles;
        });
    }

    function getImageActualResolution(src) {
        return new Promise((resolve) => {
            if (!src) {
                resolve(null);
                return;
            }
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    function updateSuiteCardResolutionBySlot(slotIndex, src, fallbackText = '') {
        const cards = document.querySelectorAll('.suite-card');
        const card = cards[slotIndex - 1];
        if (!card) return;
        const metaEl = card.querySelector('.suite-meta');
        if (!metaEl) return;
        getImageActualResolution(src).then((actual) => {
            if (actual && actual.width && actual.height) {
                metaEl.textContent = `${actual.width} x ${actual.height}`;
            } else if (fallbackText) {
                metaEl.textContent = fallbackText;
            }
        });
    }

    function addSuiteFiles(files) {
        const max = 20;
        const next = window.suiteFiles.concat(files).slice(0, max);
        window.suiteFiles = next;
        renderSuitePreviews();
    }

    // 添加单个参考图片（用于恢复历史记录）
    function addSuiteRefImage(fileData) {
        const { name, type, data } = fileData;
        debugLog('addSuiteRefImage 被调用, name:', name, 'data:', data ? '存在' : '空');
        
        // 跳过空数据
        if (!data) {
            console.warn('addSuiteRefImage: data 为空，跳过');
            return;
        }
        
        // 提取 base64 数据（兼容 data URL 和纯 base64 两种格式）
        let base64Str;
        if (data.includes(',')) {
            base64Str = data.split(',')[1];
        } else {
            base64Str = data;
        }
        
        debugLog('base64Str 长度:', base64Str ? base64Str.length : 0);
        
        // 将 base64 转换为 ArrayBuffer
        try {
            const binaryString = atob(base64Str);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            
            const mimeType = type || 'image/jpeg';
            const file = new File([bytes], name || 'image.jpg', { type: mimeType });
            debugLog('创建 File 对象成功, size:', file.size);
            addSuiteFiles([file]);
        } catch (err) {
            console.error('addSuiteRefImage 解码失败:', err);
        }
    }

    // 解析关键词文本（按段落分隔）
    function parseKeywordsFromText(text, targetCount) {
        // 尝试多种分隔方式
        const lines = text
            // 按换行符分割
            .split(/\n/)
            // 过滤空行
            .filter(line => line.trim())
            // 移除序号前缀（如 "1."、"1、"、"1:"、"1."等）
            .map(line => line.replace(/^\d+[.、:：)\]】]\s*/, '').trim())
            // 过滤纯空白或太短的行
            .filter(line => line.length > 5);

        // 如果解析出来的数量不够，返回原始文本按句子分割
        if (lines.length < targetCount / 2) {
            // 尝试按句子分割（。！？）
            const sentences = text
                .split(/[。！？.!?]/)
                .filter(s => s.trim().length > 10)
                .map(s => s.trim());

            if (sentences.length >= targetCount / 2) {
                return sentences.slice(0, targetCount);
            }
        }

        // 如果解析出来的数量超过目标，取前N条
        if (lines.length > targetCount) {
            return lines.slice(0, targetCount);
        }

        // 如果不够，重复最后一条填满
        const result = [...lines];
        while (result.length < targetCount && lines.length > 0) {
            result.push(lines[result.length % lines.length]);
        }

        return result;
    }

    // ========== 生成关键词 ==========
    // 使用 Map 存储每个任务对应的 historyId，支持多任务并行
    const pendingKeywordsTasks = new Map(); // taskId -> historyId
    const pendingImageTasks = new Map();    // taskId -> historyId

    function generateTaskId() {
        return 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    function getBackgroundTaskCount() {
        return pendingKeywordsTasks.size + pendingImageTasks.size;
    }

    function updateBackgroundTaskHint() {
        const count = getBackgroundTaskCount();
        const badge = document.getElementById('suiteBackgroundBadge');
        if (badge) {
            badge.textContent = count > 0 ? `后台运行中：${count} 个任务` : '';
            badge.style.display = count > 0 ? 'inline' : 'none';
        }
    }

    function pushTaskResultNotification(data) {
        if (typeof window.__addTaskResultNotification === 'function') {
            window.__addTaskResultNotification(data);
        }
    }

    function collectCurrentSuiteSnapshotForArchive() {
        const keywords = Array.from(document.querySelectorAll('.suite-text-area')).map(t => t.value.trim());
        const images = [];
        document.querySelectorAll('.suite-card').forEach((card, idx) => {
            const img = card.querySelector('.suite-image-slot img');
            if (img && img.src) {
                images.push({
                    index: idx + 1,
                    keyword: keywords[idx] || '',
                    imageUrl: img.src,
                    actualSize: card.querySelector('.suite-meta')?.textContent?.trim() || null
                });
            }
        });
        return {
            type: 'suite',
            prompt: '套图批量生成',
            keywords,
            images,
            model: document.getElementById('suiteGenModelInput')?.value || '',
            vlModel: document.getElementById('suiteVLModelInput')?.value || '',
            ratio: document.getElementById('suiteRatioInput')?.value || '1:1',
            size: document.getElementById('suiteSizeInput')?.value || '1K',
            rule: document.getElementById('suiteCopyInput')?.value || '',
            count: Math.max(keywords.length, images.length),
            status: images.length > 0 ? 'completed' : 'waiting_for_images'
        };
    }

    function readSuiteFileDataForHistory(file) {
        return new Promise((resolve) => {
            if (!file) {
                resolve(null);
                return;
            }
            const reader = new FileReader();
            reader.onload = (e) => resolve({ data: e.target.result, name: file.name, type: file.type });
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
        });
    }

    async function saveSuiteHistoryWithFiles(suiteHistoryItem, files) {
        const fileData = (await Promise.all(Array.from(files || []).map(readSuiteFileDataForHistory))).filter(Boolean);
        if (fileData.length > 0) {
            suiteHistoryItem.fileData = fileData;
            suiteHistoryItem.firstImage = fileData[0].data;
        }
        const savedId = await saveSuiteToDB(suiteHistoryItem);
        if (savedId) setSuiteHistoryContext(savedId, false);
        return savedId;
    }

    async function archiveCurrentSuiteFromPage() {
        try {
            let currentId = getDisplayedSuiteHistoryId();
            const snapshot = collectCurrentSuiteSnapshotForArchive();
            if (snapshot.images.length === 0) {
                showToast('当前套图没有可归档图片', 'warning');
                return;
            }
            if (!currentId) {
                await ensureSuiteArchiveWritableDirectory();
            }
            if (currentId && !window.currentSuiteHistoryReadOnly) {
                await updateSuiteHistoryInDB(Number(currentId), {
                    keywords: snapshot.keywords,
                    images: snapshot.images,
                    model: snapshot.model,
                    vlModel: snapshot.vlModel,
                    ratio: snapshot.ratio,
                    size: snapshot.size,
                    rule: snapshot.rule,
                    count: snapshot.count,
                    status: snapshot.status
                });
            }
            if (!currentId) {
                currentId = await saveSuiteToDB(snapshot);
                if (currentId && typeof setSuiteHistoryContext === 'function') {
                    setSuiteHistoryContext(currentId, false);
                }
            }
            if (!currentId) {
                showToast('当前套图历史记录保存失败，无法归档', 'error');
                return;
            }
            await archiveSuiteHistoryItem(currentId);
        } catch (err) {
            console.error('当前套图归档失败:', err);
            showToast(`归档失败：${err.message || err}`, 'error');
        }
    }

    // 新建任务：保存当前UI快照到currentSuiteHistoryId，然后清空UI
    async function suiteNewTask() {
        // 如果当前有历史ID，先把当前UI的关键词更新回DB
        const curId = getDisplayedSuiteHistoryId();
        if (curId && !window.currentSuiteHistoryReadOnly) {
            const keywords = Array.from(document.querySelectorAll('.suite-text-area')).map(t => t.value.trim());
            const images = [];
            document.querySelectorAll('.suite-card').forEach((card, idx) => {
                const img = card.querySelector('.suite-image-slot img');
                if (img && img.src) images.push({ index: idx + 1, imageUrl: img.src, keyword: keywords[idx] || '' });
            });
            await updateSuiteHistoryInDB(curId, {
                keywords,
                images,
                count: keywords.length,
                ratio: document.getElementById('suiteRatioInput')?.value || '1:1',
                size: document.getElementById('suiteSizeInput')?.value || '1K',
                rule: document.getElementById('suiteCopyInput')?.value || ''
            }).catch(() => {});
        }

        // 清空 UI
        window.suiteFiles = [];
        renderSuitePreviews();
        const countInput = document.getElementById('suiteCountInput');
        if (countInput) countInput.value = '4';
        const copyInput = document.getElementById('suiteCopyInput');
        if (copyInput) copyInput.value = '';
        const rawResponseDiv = document.getElementById('suiteRawResponse');
        if (rawResponseDiv) rawResponseDiv.style.display = 'none';
        if (curId) suiteRawResponseByHistory.delete(String(curId));
        const hint = document.getElementById('suiteHint');
        if (hint) { hint.textContent = '已新建任务，请上传参考图开始'; hint.style.color = '#10b981'; setTimeout(() => { hint.textContent = ''; hint.style.color = ''; }, 2000); }

        // 重置历史上下文
        setSuiteHistoryContext(null);
        buildSlots();
    }

    async function generateSuiteKeywords() {
        const countInput = document.getElementById('suiteCountInput');
        const ratioInput = document.getElementById('suiteRatioInput');
        const sizeInput = document.getElementById('suiteSizeInput');
        const copyInput = document.getElementById('suiteCopyInput');
        const hint = document.getElementById('suiteHint');
        const btn = document.getElementById('suiteGenKeywordsBtn');

        if (!hint || !btn) return;

        // 检查是否有图片和规则
        if (window.suiteFiles.length === 0) {
            hint.textContent = '请先上传参考图片';
            hint.style.color = '#ef4444';
            setTimeout(() => { hint.textContent = ''; hint.style.color = ''; }, 2000);
            return;
        }

        const targetCount = Math.min(12, parseInt(countInput?.value, 10) || 4);
        const rule = (copyInput?.value || '').trim();
        const suiteFilesForTask = Array.from(window.suiteFiles || []);
        // 在任何异步前立即快照DOM配置
        const snapshotRatioKw = ratioInput?.value || '1:1';
        const snapshotSizeKw = sizeInput?.value || '1K';

        detachSuiteReadOnlyHistoryForNewWork();

        // 反推开始时清空原始回传（旧任务残留）
        const curDisplayId = getDisplayedSuiteHistoryId();
        if (curDisplayId) suiteRawResponseByHistory.delete(String(curDisplayId));
        const rawDiv = document.getElementById('suiteRawResponse');
        if (rawDiv) rawDiv.style.display = 'none';

        // 反推开始时清空当前卡槽图片，避免误导
        if (isSuiteHistoryDisplayed(curDisplayId)) {
            document.querySelectorAll('.suite-card').forEach(card => {
                const imageSlot = card.querySelector('.suite-image-slot');
                if (imageSlot) imageSlot.innerHTML = '';
                const textarea = card.querySelector('.suite-text-area');
                if (textarea) textarea.value = '';
                card.classList.remove('suite-view-image');
                card.classList.add('suite-view-text');
                card.querySelectorAll('.suite-tab-btn').forEach(b => b.classList.remove('active'));
                const textBtn = card.querySelector('.suite-tab-text');
                if (textBtn) textBtn.classList.add('active');
            });
        }

        // 生成任务ID，用于追踪这个任务的 historyId
        const taskId = generateTaskId();

        // 立即创建历史记录（不等 API 返回）
        const immediateHistoryItem = {
            type: 'suite',
            prompt: '套图批量生成',
            keywords: [], // 初始为空，等待生成
            images: [], // 初始为空
            model: document.getElementById('suiteGenModelInput')?.value || '',
            vlModel: (() => {
                const v = document.getElementById("suiteVLModelInput")?.value?.trim();
                const m = document.getElementById("modelSelect")?.value;
                return v || m || 'gemini-2.0-flash';
            })(),
            ratio: snapshotRatioKw,
            size: snapshotSizeKw,
            rule: rule,
            count: targetCount, // 保存卡槽数量
            timestamp: new Date().getTime(),
            status: 'generating_keywords', // 标记状态：正在生成关键词
            taskId: taskId // 关联任务ID
        };

        // 保存参考图（读取 base64 数据以便切换时恢复）
        if (suiteFilesForTask.length > 0) {
            debugLog('保存参考图, window.suiteFiles.length:', suiteFilesForTask.length);
            // 异步读取所有图片的 base64 数据
            const fileDataPromises = suiteFilesForTask.map(async (file) => {
                const base64Data = await fileToBase64(file);
                const dataUrl = `data:${file.type};base64,${base64Data}`;
                debugLog('读取图片:', file.name, 'dataUrl长度:', dataUrl.length);
                return {
                    name: file.name,
                    type: file.type,
                    data: dataUrl
                };
            });
            immediateHistoryItem.fileData = await Promise.all(fileDataPromises);
            // firstImage 用于历史列表缩略图显示
            immediateHistoryItem.firstImage = immediateHistoryItem.fileData[0]?.data || null;
            
            // 保存当前配置（model、ratio、pixel、sdModel 等），确保多任务时不互相覆盖
            const vlModelInput = document.getElementById("suiteVLModelInput");
            const modelSelect = document.getElementById("modelSelect");
            immediateHistoryItem.vlModel = (vlModelInput && vlModelInput.value.trim()) || (modelSelect ? modelSelect.value : 'gemini-2.0-flash');
            
            immediateHistoryItem.ratio = snapshotRatioKw;
            immediateHistoryItem.size = snapshotSizeKw;
            
            const sdModelInput = document.getElementById("suiteSDModelInput");
            immediateHistoryItem.sdModel = sdModelInput ? sdModelInput.value.trim() : '';
            
            debugLog('fileData 和配置已保存, 条目数:', immediateHistoryItem.fileData.length, 'vlModel:', immediateHistoryItem.vlModel);
        } else {
            debugLog('没有参考图需要保存');
        }

        // 立即保存到数据库，并记录 taskId -> historyId 的映射
        // 规则：生成关键词失败或关键词为空时，复用原记录；否则新建
        let historyId;
        const displayedId = getDisplayedSuiteHistoryId();
        let canReuse = false;
        
        if (displayedId && !window.currentSuiteHistoryReadOnly) {
            try {
                const existingItem = await readHistoryItemById(displayedId);
                const existingKeywords = Array.isArray(existingItem?.keywords) ? existingItem.keywords.filter(Boolean) : [];
                const existingStatus = existingItem?.status || '';
                // 只有当原记录关键词为空（失败或未生成）时才复用
                if (existingKeywords.length === 0 && 
                    (existingStatus === 'failed' || existingStatus === 'generating_keywords' || existingStatus === 'keywords_failed' || existingStatus === 'images_failed' || existingKeywords.length === 0)) {
                    canReuse = true;
                }
            } catch (e) {
                console.warn('检查现有历史记录失败:', e);
            }
        }
        
        if (canReuse) {
            // 复用原记录：更新状态和配置
            await updateSuiteHistoryInDB(displayedId, {
                status: 'generating_keywords',
                keywords: [],
                taskId: taskId,
                rule: immediateHistoryItem.rule,
                count: immediateHistoryItem.count,
                ratio: snapshotRatioKw,
                size: snapshotSizeKw,
                fileData: immediateHistoryItem.fileData,
                firstImage: immediateHistoryItem.firstImage,
                vlModel: immediateHistoryItem.vlModel,
                sdModel: immediateHistoryItem.sdModel
            }).catch(() => {});
            historyId = displayedId;
            debugLog('复用已有历史记录（关键词为空）, id:', historyId);
        } else {
            // 新建历史记录
            historyId = await saveSuiteToDB(immediateHistoryItem);
            debugLog('新建历史记录, id:', historyId);
        }
        if (!historyId) {
            hint.textContent = '历史记录保存失败，请刷新页面后重试';
            hint.style.color = '#ef4444';
            return;
        }
        pendingKeywordsTasks.set(taskId, historyId);
        // 设置当前任务的ID（用于数据库关联），readOnly=false
        setSuiteHistoryContext(historyId, false);
        // 标记当前正在展示这个任务（因为用户正在看这个任务）
        // 这样回调完成后检查 window.currentDisplayedSuiteHistoryId === historyId 能通过，才能正确填词
        debugLog('套图历史记录已创建, id:', historyId, 'taskId:', taskId, 'status: generating_keywords');

        // 提示用户任务已开始（立即返回）
        // 使用 taskId 作为任务标识，显示在 hint 中
        hint.dataset.currentTaskId = taskId;
        setSuiteRunningStatus(historyId, taskId, 'keywords', '图片反推中...');

        // 后台执行 API 调用，不阻塞 UI
        executeKeywordsGeneration(taskId, historyId, targetCount, rule, hint, countInput, suiteFilesForTask, snapshotRatioKw, snapshotSizeKw).catch(error => {
            console.error('关键词生成后台任务异常:', error);
        });
    }

    // 在后台执行关键词生成，不阻塞 UI
    async function executeKeywordsGeneration(taskId, historyId, targetCount, rule, hint, countInput, filesForTask = [], snapshotRatio = '1:1', snapshotSize = '1K') {
        try {
            // 检查任务是否被取消（通过检查 hint.dataset.currentTaskId）
            const checkTaskCancelled = () => hint.dataset.currentTaskId !== taskId;
            
            // 先从数据库读取保存的配置，确保使用任务开始时的配置而不是当前的全局配置
            let savedConfig = null;
            try {
                savedConfig = await readHistoryItemById(historyId);
                debugLog('读取保存的配置:', savedConfig);
            } catch (readErr) {
                console.warn('读取历史记录配置失败:', readErr);
            }
            
            // 使用保存的配置（优先）或当前配置
            const savedVlModel = savedConfig?.vlModel;
            const savedRatio = savedConfig?.ratio;
            const savedSdModel = savedConfig?.sdModel;
            
            // 立即更新历史记录的 count，确保切换时能看到正确的卡槽数量
            if (historyId && targetCount) {
                updateSuiteHistoryInDB(historyId, { count: targetCount }).catch(err => {
                    console.warn('更新历史记录 count 失败:', err);
                });
            }

            // 获取配置（优先使用保存的配置）
            const token = document.getElementById("token")?.value?.trim();
            const chatApiBase = document.getElementById("chatApiBase")?.value?.trim();
            const model = savedVlModel || (document.getElementById("suiteVLModelInput")?.value?.trim()) || (document.getElementById("modelSelect")?.value || 'gemini-2.0-flash');

            // 判断是否使用 ModelScope API（Qwen3、Kimi 等模型）或 gpt-5.5
            const isModelScope = model.startsWith('Qwen/') || model.includes('Qwen3') || model.startsWith('moonshotai/');
            const isGPT55 = model === 'gpt-5.5';
            let apiBase, modelId, requestToken;

            if (isModelScope) {
                apiBase = "https://api-inference.modelscope.cn";
                modelId = model;
                requestToken = document.getElementById("modelscopeToken")?.value?.trim();
                if (!requestToken) {
                    throw new Error('使用 Qwen3 模型需要填写 ModelScope Token');
                }
            } else if (isGPT55) {
                // gpt-5.5 使用专用 API
                apiBase = "https://grsaiapi.com";
                modelId = model;
                requestToken = token;
                if (!requestToken) {
                    throw new Error('请先填写 API Token');
                }
            } else {
                apiBase = chatApiBase || getDefaultChatApiBase();
                modelId = model;
                requestToken = token;
                if (!requestToken) {
                    throw new Error('请先填写 API Token');
                }
            }

            const url = `${apiBase.replace(/\/$/, '')}/v1/chat/completions`;

            // 构造消息内容
            const content = [];

            // 添加图片（ModelScope API 需要压缩图片到 5MB 以下）
            for (const file of filesForTask) {
                let processedFile = file;
                
                // 如果是 ModelScope API 或图片太大，先压缩
                if (isModelScope || file.size > 4 * 1024 * 1024) {
                    try {
                        processedFile = await compressImage(file);
                        debugLog(`📦 图片压缩: ${(file.size / 1024 / 1024).toFixed(2)}MB -> ${(processedFile.size / 1024 / 1024).toFixed(2)}MB`);
                    } catch (compressErr) {
                        console.warn('⚠️ 图片压缩失败，使用原图:', compressErr);
                    }
                }
                
                const base64Data = await fileToBase64(processedFile);
                content.push({
                    type: "image_url",
                    image_url: {
                        url: `data:${processedFile.type};base64,${base64Data}`
                    }
                });
            }

            // 添加文本提示
            const textPrompt = rule || `请基于这张图片，生成${targetCount}条不同的AI绘图关键词，每条一行，直接输出，不要编号不要前缀。`;
            content.push({
                type: "text",
                text: textPrompt
            });

            // 构造请求体
            const payload = {
                model: modelId,
                stream: false,
                messages: [
                    {
                        role: "system",
                        content: "You are a helpful assistant that can analyze images and provide detailed descriptions."
                    },
                    {
                        role: "user",
                        content: content
                    }
                ]
            };

            // 发送请求
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${requestToken}`
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error?.message || errorData.message || `HTTP ${response.status}`);
            }

            const data = await response.json();

            // 解析返回的文本
            const text = parseTextFromResponse(data);
            if (!text) {
                throw new Error('未获取到反推结果');
            }

            // 分割关键词
            const keywords = parseKeywordsFromText(text, targetCount);

            // 生成关键词后更新已创建的历史记录（先更新数据库）
            const updates = {
                keywords: keywords,
                status: 'waiting_for_images',
                vlModel: savedVlModel || model,
                ratio: savedRatio || savedConfig?.ratio || snapshotRatio || '1:1',
                size: savedConfig?.size || snapshotSize || '1K',
                sdModel: savedSdModel || '',
                count: targetCount,
                rawResponse: text
            };

            // 反推完成只更新当前记录内容，不移动历史位置，避免重排打断卡槽回填
            await updateSuiteHistoryInDB(historyId, updates);
            debugLog('套图历史记录已更新, id:', historyId, 'taskId:', taskId);

            // 检查当前展示的历史记录ID是否匹配，只有匹配时才更新DOM
            if (isSuiteHistoryDisplayed(historyId)) {
                debugLog('关键词生成完成，更新当前页面DOM');
                
                // 显示原始回传结果，同时存入Map供切换任务后恢复
                const rawResponseDiv = document.getElementById('suiteRawResponse');
                const rawTextDiv = document.getElementById('suiteRawText');
                if (rawResponseDiv && rawTextDiv) {
                    rawTextDiv.textContent = text;
                    rawResponseDiv.style.display = 'block';
                }
                if (historyId) suiteRawResponseByHistory.set(String(historyId), text);
                
                // 先创建/调整卡槽
                if (countInput) countInput.value = String(targetCount);
                buildSlots();

                // 等待DOM更新
                await new Promise(resolve => setTimeout(resolve, 100));

                // 填入关键词
                const textareas = document.querySelectorAll('.suite-text-area');
                textareas.forEach((textarea, index) => {
                    if (index < keywords.length) {
                        textarea.value = keywords[index];
                    }
                });

                hint.textContent = `成功生成 ${keywords.length} 条关键词`;
                hint.style.color = '#10b981';
            } else {
                debugLog('关键词生成完成，但当前展示的不是该任务，不更新DOM，historyId:', historyId, 'currentDisplayed:', window.currentDisplayedSuiteHistoryId);
                // 可以通过 toast 提示用户任务完成
                if (typeof window.showToast === 'function') {
                    window.showToast(`任务 ${historyId} 的关键词已生成完成`);
                }
            }

            await touchSuiteHistoryInDB(historyId, {});
            pushTaskResultNotification({
                historyId,
                taskId,
                taskType: 'suite',
                stage: 'reverse',
                status: 'success',
                title: '套图反推完成',
                message: `已生成 ${keywords.length}/${targetCount} 条关键词`,
                successCount: keywords.length,
                failCount: Math.max(0, targetCount - keywords.length),
                totalCount: targetCount
            });

        } catch (error) {
            console.error('生成关键词失败:', error);
            if (isSuiteHistoryDisplayed(historyId) && hint.dataset.currentTaskId === taskId) {
                hint.textContent = '';
                hint.style.color = '';
                hint.dataset.currentTaskId = '';
            }
            
            // 更新历史记录状态为失败
            updateSuiteHistoryInDB(historyId, { status: 'keywords_failed', error: error.message });
            pushTaskResultNotification({
                historyId,
                taskId,
                taskType: 'suite',
                stage: 'reverse',
                status: 'failed',
                title: '套图反推失败',
                message: error.message || String(error || '反推失败')
            });
        } finally {
            clearSuiteRunningStatus(historyId, taskId);
            if (hint.dataset.currentTaskId === taskId) {
                hint.textContent = '';
                hint.style.color = '';
                hint.dataset.currentTaskId = '';
            }
            // 清理任务映射
            pendingKeywordsTasks.delete(taskId);
            updateBackgroundTaskHint();
        }
    }

    // 单个卡槽生图
    async function generateSingleSlotImage(slotIndex) {
        const hint = document.getElementById('suiteHint');
        const textarea = document.querySelector(`.suite-text-area[data-index="${slotIndex}"]`);
        const keyword = textarea?.value?.trim();

        if (!keyword) {
            if (hint) {
                hint.textContent = '请先输入关键词';
                hint.style.color = '#ef4444';
                setTimeout(() => { hint.textContent = ''; hint.style.color = ''; }, 2000);
            }
            return;
        }

        if (window.suiteFiles.length === 0) {
            if (hint) {
                hint.textContent = '请先上传参考图片';
                hint.style.color = '#ef4444';
                setTimeout(() => { hint.textContent = ''; hint.style.color = ''; }, 2000);
            }
            return;
        }
        const suiteFilesForTask = Array.from(window.suiteFiles || []);

        // 在任何异步前快照DOM配置
        const token = document.getElementById("token")?.value?.trim();
        const drawApiBase = document.getElementById("drawApiBase")?.value?.trim();
        const aspectRatio = document.getElementById('suiteRatioInput')?.value || '1:1';
        const imageSize = document.getElementById('suiteSizeInput')?.value || '1K';

        if (!token) {
            if (hint) {
                hint.textContent = '请先填写 API Token';
                hint.style.color = '#ef4444';
                setTimeout(() => { hint.textContent = ''; hint.style.color = ''; }, 2000);
            }
            return;
        }

        const modelSelect = document.getElementById("suiteGenModelInput");
        const model = modelSelect ? modelSelect.value : 'nano-banana-fast';
        if (detachSuiteReadOnlyHistoryForNewWork()) {
            window.currentDisplayedSuiteHistoryId = null;
        }
        let slotTaskHistoryId = getDisplayedSuiteHistoryId();
        const slotTaskId = `single_img_${Date.now()}_${slotIndex}`;
        const isSlotTaskDisplayed = () => !slotTaskHistoryId || isSuiteHistoryDisplayed(slotTaskHistoryId);

        if (hint) {
            if (slotTaskHistoryId) {
                setSuiteRunningStatus(slotTaskHistoryId, slotTaskId, 'images', `图片生成中...（卡槽 #${slotIndex}）`);
            } else {
                hint.textContent = `正在为卡槽 #${slotIndex} 生成图片...`;
                hint.style.color = '';
            }
        }

        try {
            const apiBase = drawApiBase || getDefaultDrawApiBase();
            const isGPTImage2 = isGPTImage2Model(model);
            const submitUrl = `${apiBase.replace(/\/$/, '')}${isGPTImage2 ? '/v1/draw/completions' : '/v1/draw/nano-banana'}`;
            const resultUrl = `${apiBase.replace(/\/$/, '')}/v1/draw/result`;

            // 准备参考图
            let imageUrls = [];
            for (const file of suiteFilesForTask) {
                const base64Data = await fileToBase64(file);
                imageUrls.push(`data:${file.type};base64,${base64Data}`);
            }

            // 构造绘图 API payload（与常规模式一致）
            const singleGptSize = calculateGPTImage2Size(imageSize || '1K', aspectRatio || '1:1');
            const singleGptQuality = model === 'gpt-image-2-vip'
                ? (GPT_IMAGE2_QUALITY_MAP[imageSize] || 'low')
                : undefined;
            const payload = isGPTImage2
                ? {
                    model: model === 'gpt-image-2-vip' ? 'gpt-image-2-vip' : 'gpt-image-2',
                    prompt: keyword,
                    size: singleGptSize,
                    ...(singleGptQuality ? { quality: singleGptQuality } : {}),
                    urls: imageUrls,
                    webHook: "-1",
                    shutProgress: false
                }
                : {
                    model: model,
                    prompt: keyword,
                    aspectRatio: aspectRatio || '1:1',
                    imageSize: imageSize || '1K',
                    urls: imageUrls,
                    webHook: "-1",
                    shutProgress: true
                };

            debugLog("🎨 套图模式提交绘图任务:", payload);

            // 提交任务
            const submitResponse = await fetch(submitUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });

            if (!submitResponse.ok) {
                const errorText = await submitResponse.text();
                throw new Error(`提交失败: HTTP ${submitResponse.status} - ${errorText.substring(0, 200)}`);
            }

            const submitData = await submitResponse.json();
            debugLog("📨 提交响应:", submitData);

            if (submitData.code !== 0 || !submitData.data?.id) {
                throw new Error(submitData.msg || "提交任务失败，未获取到任务ID");
            }

            const taskId = submitData.data.id;
            debugLog("✅ 任务已提交，ID:", taskId);

            // 轮询获取结果
            let imageUrl = parseImageFromResponse(submitData.data?.results?.[0] || submitData.data);
            while (!imageUrl) {
                await new Promise(resolve => setTimeout(resolve, 1000));

                const resultResponse = await fetch(resultUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${token}`
                    },
                    body: JSON.stringify({ id: taskId })
                });

                if (!resultResponse.ok) continue;

                const resultData = await resultResponse.json();
                debugLog("📨 轮询结果:", resultData);

                if (resultData.code !== 0) {
                    throw new Error(resultData.msg || "生成失败");
                }

                const data = resultData.data;
                if (data?.status === 'failed') {
                    throw new Error(data?.message || "生成失败");
                }

                imageUrl = parseImageFromResponse(data?.results?.[0] || data);
                if (imageUrl) {
                    break;
                }
            }
            imageUrl = String(imageUrl || '').trim();

            if (!imageUrl) {
                throw new Error('未获取到图片');
            }

            debugLog("✅ 图片生成成功:", imageUrl);

            // 显示图片
            if (isSlotTaskDisplayed()) {
                const cards = document.querySelectorAll('.suite-card');
                if (cards[slotIndex - 1]) {
                    const card = cards[slotIndex - 1];
                    // 切换到图片视图
                    card.classList.remove('suite-view-text');
                    card.classList.add('suite-view-image');
                    card.querySelectorAll('.suite-tab-btn').forEach(b => b.classList.remove('active'));
                    const imgBtn = card.querySelector('.suite-tab-image');
                    if (imgBtn) imgBtn.classList.add('active');
                    renderSuiteImageIntoSlot(card, imageUrl, slotIndex, `卡槽 ${slotIndex} 图片`);
                }

                updateSuiteCardResolutionBySlot(slotIndex, imageUrl, `${getTargetResolution(imageSize, aspectRatio).width} x ${getTargetResolution(imageSize, aspectRatio).height}`);
            }

            if (slotTaskHistoryId) {
                persistSingleSlotImage(slotTaskHistoryId, slotIndex, keyword, imageUrl, aspectRatio, imageSize, model).catch(err => {
                    console.warn('单卡槽图片写回历史失败:', err);
                });
            } else {
                const allKeywords = Array.from(document.querySelectorAll('.suite-text-area')).map(t => (t.value || '').trim());
                const currentCount = Math.max(Number(document.getElementById('suiteCountInput')?.value) || 0, allKeywords.length, slotIndex);
                while (allKeywords.length < currentCount) allKeywords.push('');
                const suiteHistoryItem = {
                    type: 'suite',
                    prompt: '套图单卡槽生成',
                    keywords: allKeywords,
                    images: [{ index: slotIndex, keyword, imageUrl, actualSize: null }],
                    model,
                    vlModel: document.getElementById('suiteVLModelInput')?.value || '',
                    ratio: aspectRatio,
                    size: imageSize,
                    rule: document.getElementById('suiteCopyInput')?.value || '',
                    count: currentCount,
                    status: currentCount <= 1 ? 'completed' : 'waiting_for_images',
                    skipKeywordCleanup: true
                };
                slotTaskHistoryId = await saveSuiteHistoryWithFiles(suiteHistoryItem, suiteFilesForTask);
            }

            if (hint) {
                hint.textContent = `卡槽 #${slotIndex} 图片生成成功`;
                hint.style.color = '#10b981';
                setTimeout(() => { hint.textContent = ''; hint.style.color = ''; }, 3000);
            }

            // 注意：历史记录只在批量生成（generateSuiteImages）时统一保存
            // 单个卡槽生成成功时不单独保存，避免重复

        } catch (error) {
            console.error('生成失败:', error);
            if (hint && !slotTaskHistoryId) {
                hint.textContent = '生成失败: ' + error.message;
                hint.style.color = '#ef4444';
                setTimeout(() => { hint.textContent = ''; hint.style.color = ''; }, 3000);
            }
        } finally {
            if (slotTaskHistoryId) {
                clearSuiteRunningStatus(slotTaskHistoryId, slotTaskId);
            }
        }
    }

    // ========== 生成图片 ==========
    function renderSuiteImageIntoSlot(card, imageUrl, slotIndex, labelText = '') {
        if (!card || !imageUrl) return;

        const imageSlot = card.querySelector('.suite-image-slot');
        if (!imageSlot) return;

        const safeUrl = String(imageUrl).replace(/'/g, "\\'");
        const displayLabel = labelText || `卡槽 ${slotIndex} 图片`;
        const fileName = `suite-slot-${slotIndex}-${Date.now()}.png`;

        imageSlot.innerHTML = `
            <div style="width:100%;height:100%;display:flex;flex-direction:column;gap:8px;align-items:stretch;">
                <img src="${imageUrl}" style="flex:1;min-height:0;width:100%;object-fit:contain;cursor:zoom-in;" onclick="openPreviewFromUrl('${safeUrl}', '${displayLabel}');event.stopPropagation();" />
                <div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap;">
                    <button class="btn-secondary" style="padding:4px 8px;font-size:11px;" onclick="event.stopPropagation(); forceDownload(event, '${safeUrl}', '${fileName}')">
                        <i class="fas fa-download"></i> 下载
                    </button>
                </div>
            </div>
        `;
    }

    async function persistSingleSlotImage(historyId, slotIndex, keyword, imageUrl, aspectRatio, imageSize, model) {
        const item = await readHistoryItemById(historyId);
        if (!item || item.type !== 'suite') return null;

        const index = Number(slotIndex);
        const count = Math.max(Number(item.count) || 0, index);
        const images = Array.isArray(item.images) ? item.images.filter(img => Number(img?.index) !== index) : [];
        const failedSlots = Array.isArray(item.failedSlots) ? item.failedSlots.filter(slot => Number(slot?.index) !== index) : [];
        const keywords = Array.isArray(item.keywords) ? item.keywords.slice() : [];
        while (keywords.length < count) keywords.push('');
        keywords[index - 1] = keyword || keywords[index - 1] || '';

        images.push({
            index,
            keyword: keyword || '',
            imageUrl,
            actualSize: null
        });
        images.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));

        const status = failedSlots.length > 0
            ? (images.length > 0 ? 'images_partial_failed' : 'images_failed')
            : (images.length >= count ? 'completed' : 'waiting_for_images');

        return updateSuiteHistoryInDB(historyId, {
            images,
            keywords,
            failedSlots,
            status,
            error: failedSlots.length > 0 ? failedSlots.map(slot => `卡槽 ${slot.index}: ${slot.error}`).join('\n') : '',
            ratio: aspectRatio || item.ratio || '1:1',
            size: imageSize || item.size || '1K',
            model: model || item.model || ''
        });
    }

    async function generateSuiteImages() {
        const hint = document.getElementById('suiteHint');
        const btn = document.getElementById('suiteGenImagesBtn');
        if (!hint || !btn) return;

        const slots = Array.from(document.querySelectorAll('.suite-text-area'))
            .map((textarea, index) => ({ index: index + 1, keyword: (textarea.value || '').trim() }))
            .filter(slot => slot.keyword);

        if (slots.length === 0) {
            hint.textContent = '请先在卡槽中输入关键词';
            hint.style.color = '#ef4444';
            setTimeout(() => { hint.textContent = ''; hint.style.color = ''; }, 2000);
            return;
        }
        if (window.suiteFiles.length === 0) {
            hint.textContent = '请先上传参考图片';
            hint.style.color = '#ef4444';
            setTimeout(() => { hint.textContent = ''; hint.style.color = ''; }, 2000);
            return;
        }
        const suiteFilesForTask = Array.from(window.suiteFiles || []);

        // 在任何异步操作前立即从DOM快照锁定配置，避免切换任务后DOM被污染
        const snapshotRatio = document.getElementById('suiteRatioInput')?.value || '1:1';
        const snapshotSize = document.getElementById('suiteSizeInput')?.value || '1K';
        const snapshotModel = document.getElementById('suiteGenModelInput')?.value || 'nano-banana-fast';

        const token = document.getElementById('token')?.value?.trim();
        const drawApiBase = document.getElementById('drawApiBase')?.value?.trim();
        
        // 先读取当前显示的历史记录作为配置参考
        let savedConfig = null;
        const displayedHistoryId = getDisplayedSuiteHistoryId();
        try {
            if (displayedHistoryId) {
                savedConfig = await readHistoryItemById(displayedHistoryId);
            }
        } catch (readErr) {
            console.warn('读取历史记录配置失败:', readErr);
        }
        
        // 检查关键词对应的卡槽是否有图片
        // 如果有任意一张图片 → 新建历史；全部为空/失败 → 复用当前历史
        const hasAnyImage = slots.some((slot, index) => {
            const card = document.querySelectorAll('.suite-card')[index];
            if (card) {
                const img = card.querySelector('.suite-image-slot img');
                if (img && img.src) return true;
            }
            return false;
        });
        
        // 使用函数开头锁定的快照值，不再读取可能已被切换任务污染的DOM或savedConfig
        const aspectRatio = snapshotRatio;
        const imageSize = snapshotSize;
        const cachedRatio = aspectRatio;
        const cachedSize = imageSize;

        // 使用时间戳作为任务ID，支持多任务并行（必须在 hasAnyImage 块之前声明，块内会引用）
        const imageTaskId = 'img_' + Date.now();

        // 规则：卡槽有图片则新建历史，否则复用当前历史追加图片
        // 注意：即使新建历史，也需要一个ID来实时更新图片进度
        let currentTaskHistoryId;
        if (hasAnyImage) {
            // 卡槽有图片：新建历史，先创建一个初始记录用于实时更新
            const initialHistoryItem = {
                id: Date.now(),
                type: 'suite',
                prompt: '套图批量生成',
                keywords: slots.map(s => s.keyword),
                images: [],
                model: savedConfig?.model || document.getElementById('suiteGenModelInput')?.value || '',
                vlModel: savedConfig?.vlModel || document.getElementById('suiteVLModelInput')?.value || '',
                sdModel: savedConfig?.sdModel || '',
                ratio: savedConfig?.ratio || cachedRatio,
                size: savedConfig?.size || cachedSize,
                rule: savedConfig?.rule || document.getElementById('suiteCopyInput')?.value || '',
                count: slots.length,
                status: 'generating_images',
                timestamp: Date.now(),
                taskId: imageTaskId
            };
            // 如果有原历史记录的参考图，复制过来；否则从卡槽现有图片取第一张作为预览
            if (savedConfig?.fileData && savedConfig.fileData.length > 0) {
                initialHistoryItem.fileData = savedConfig.fileData;
                initialHistoryItem.firstImage = savedConfig.firstImage;
            } else {
                // 兜底：从卡槽第一张图片取 firstImage（用于历史列表缩略图）
                const firstSlotImg = document.querySelector('.suite-card .suite-image-slot img');
                if (firstSlotImg && firstSlotImg.src) {
                    initialHistoryItem.firstImage = firstSlotImg.src;
                }
            }
            currentTaskHistoryId = await saveSuiteToDB(initialHistoryItem);
            if (currentTaskHistoryId) {
                setSuiteHistoryContext(currentTaskHistoryId, false);
                if (typeof loadHistory === 'function') loadHistory();
            }
            debugLog('卡槽有图片，新建历史记录:', currentTaskHistoryId);
        } else {
            // 卡槽无图片：复用当前历史
            currentTaskHistoryId = displayedHistoryId;
            debugLog('卡槽无图片，复用当前历史记录:', currentTaskHistoryId);
        }
        
        // 清空当前卡槽图片，避免误导
        document.querySelectorAll('.suite-card').forEach(card => {
            const imageSlot = card.querySelector('.suite-image-slot');
            if (imageSlot) imageSlot.innerHTML = '';
            card.classList.remove('suite-view-image');
            card.classList.add('suite-view-text');
            card.querySelectorAll('.suite-tab-btn').forEach(b => b.classList.remove('active'));
            const textBtn = card.querySelector('.suite-tab-text');
            if (textBtn) textBtn.classList.add('active');
        });
        
        const genModel = savedConfig?.model || snapshotModel;
        if (!token) {
            hint.textContent = '请先填写 API Token';
            hint.style.color = '#ef4444';
            setTimeout(() => { hint.textContent = ''; hint.style.color = ''; }, 2000);
            return;
        }

        hint.dataset.imageTaskId = imageTaskId;
        pendingImageTasks.set(imageTaskId, currentTaskHistoryId);
        updateBackgroundTaskHint();
        
        // 图片生成状态提示：保存到 suiteRunningStatusByHistory，支持切换历史时显示
        // 使用 currentTaskHistoryId（复用时）或 displayedHistoryId（新建时）作为key
        const statusKey = currentTaskHistoryId || displayedHistoryId;
        if (statusKey) {
            setSuiteRunningStatus(statusKey, imageTaskId, 'images', `图片生成中...（${slots.length}张）`);
        }
        
        // 同时显示 suiteStatusBar（不会被历史加载覆盖）
        const statusBar = document.getElementById('suiteStatusBar');
        const statusBarText = document.getElementById('suiteStatusBarText');
        if (statusBar && statusBarText) {
            statusBarText.textContent = `图片生成中...（${slots.length}张）`;
            statusBar.style.display = 'flex';
        }

        // 保存当前任务的 historyId，避免切换任务时被覆盖
        // 标记当前正在展示这个任务（因为用户正在看这个任务）
        // 这样回调完成后检查 window.currentDisplayedSuiteHistoryId 能通过，才能正确更新图片
        if (currentTaskHistoryId) {
            window.currentDisplayedSuiteHistoryId = currentTaskHistoryId;
        }

        const apiBase = drawApiBase || getDefaultDrawApiBase();
        const model = genModel;
        const isGPTImage2 = isGPTImage2Model(model);
        const submitUrl = `${apiBase.replace(/\/$/, '')}${isGPTImage2 ? '/v1/draw/completions' : '/v1/draw/nano-banana'}`;
        const resultUrl = `${apiBase.replace(/\/$/, '')}/v1/draw/result`;
        const referenceUrls = await Promise.all(suiteFilesForTask.map(async (file) => `data:${file.type};base64,${await fileToBase64(file)}`));
        const suiteImageMeta = [];
        const suiteImageByIndex = new Map();
        const normalizeImageUrl = (value) => String(value || '').trim();

        // 检查当前展示的历史记录ID是否与任务ID匹配
        const isCurrentDisplayed = () => isSuiteHistoryDisplayed(currentTaskHistoryId);
        
        const applyImageToCard = (slotIndex, imageUrl) => {
            // 只有当前展示的是该任务时才更新DOM
            if (!isCurrentDisplayed()) {
                debugLog('图片生成完成，但当前展示的不是该任务，不更新DOM');
                return false;
            }
            const card = document.querySelectorAll('.suite-card')[slotIndex - 1];
            if (!card) return false;
            card.classList.remove('suite-view-text');
            card.classList.add('suite-view-image');
            card.querySelectorAll('.suite-tab-btn').forEach(b => b.classList.remove('active'));
            const imgBtn = card.querySelector('.suite-tab-image');
            if (imgBtn) imgBtn.classList.add('active');
            renderSuiteImageIntoSlot(card, imageUrl, slotIndex, `卡槽 ${slotIndex} 图片`);
            return true;
        };
        
        // 显示生成失败状态
        const showSlotError = (slotIndex, errorMsg) => {
            if (!isCurrentDisplayed()) {
                debugLog('图片生成失败，但当前展示的不是该任务，不更新DOM');
                return;
            }
            const card = document.querySelectorAll('.suite-card')[slotIndex - 1];
            renderSuiteFailedSlot(card, errorMsg);
        };

        const pollImage = async (taskId, slotIndex) => {
            while (true) {
                const resultResponse = await fetch(resultUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ id: taskId })
                });
                if (!resultResponse.ok) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                const resultData = await resultResponse.json();
                debugLog(`📨 卡槽 ${slotIndex} 轮询结果:`, resultData);
                if (resultData.code !== 0) throw new Error(resultData.msg || '生成失败');
                const data = resultData.data;
                if (data?.status === 'failed') throw new Error(data?.message || '生成失败');
                const parsed = parseImageFromResponse(data?.results?.[0] || data);
                if (parsed) return parsed;
                await new Promise(r => setTimeout(r, 1000));
            }
        };

        const batchGptQuality = model === 'gpt-image-2-vip'
            ? (GPT_IMAGE2_QUALITY_MAP[imageSize] || 'low')
            : undefined;
        const batchGptSize = calculateGPTImage2Size(imageSize || '1K', aspectRatio || '1:1');
        const runSlot = async (slot) => {
            const payload = isGPTImage2 ? {
                model: model === 'gpt-image-2-vip' ? 'gpt-image-2-vip' : 'gpt-image-2',
                prompt: slot.keyword,
                size: batchGptSize,
                ...(batchGptQuality ? { quality: batchGptQuality } : {}),
                urls: referenceUrls,
                webHook: '-1',
                shutProgress: false
            } : {
                model,
                prompt: slot.keyword,
                aspectRatio: aspectRatio || '1:1',
                imageSize: imageSize || '1K',
                urls: referenceUrls,
                webHook: '-1',
                shutProgress: true
            };

            debugLog(`🎨 套图批量生成 - 卡槽 ${slot.index}:`, payload);
            const submitResponse = await fetch(submitUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(payload)
            });
            if (!submitResponse.ok) throw new Error(`提交失败: HTTP ${submitResponse.status}`);
            const submitData = await submitResponse.json();
            if (submitData.code !== 0 || !submitData.data?.id) throw new Error(submitData.msg || '提交任务失败');

            const taskId = submitData.data.id;
            let imageUrl = parseImageFromResponse(submitData.data?.results?.[0] || submitData.data);
            if (!imageUrl) imageUrl = await pollImage(taskId, slot.index);
            imageUrl = normalizeImageUrl(imageUrl);
            if (!imageUrl) throw new Error('未获取到图片');

            const metaEntry = { index: slot.index, keyword: slot.keyword, imageUrl, actualSize: null };
            suiteImageMeta.push(metaEntry);
            suiteImageByIndex.set(slot.index, metaEntry);
            const appliedToCurrentCard = applyImageToCard(slot.index, imageUrl);
            if (isCurrentDisplayed() && !appliedToCurrentCard) throw new Error(`未找到卡槽 ${slot.index}`);
            const targetResolution = getTargetResolution(imageSize, aspectRatio);
            if (appliedToCurrentCard) {
                updateSuiteCardResolutionBySlot(slot.index, imageUrl, `${targetResolution.width} x ${targetResolution.height}`);
            }
            // 优先从已渲染的 img 元素读真实尺寸，避免跨域重新加载失败
            const getActualSize = () => new Promise((resolve) => {
                const cards = document.querySelectorAll('.suite-card');
                const card = cards[slot.index - 1];
                const domImg = card?.querySelector('.suite-image-slot img');
                if (domImg) {
                    if (domImg.complete && domImg.naturalWidth) {
                        resolve({ width: domImg.naturalWidth, height: domImg.naturalHeight });
                    } else {
                        domImg.onload = () => resolve({ width: domImg.naturalWidth, height: domImg.naturalHeight });
                        domImg.onerror = () => resolve(null);
                        setTimeout(() => resolve(null), 8000);
                    }
                } else {
                    getImageActualResolution(imageUrl).then(resolve);
                }
            });
            getActualSize().then((actual) => {
                const entry = suiteImageByIndex.get(slot.index);
                if (entry && actual?.width && actual?.height) {
                    entry.actualSize = `${actual.width} x ${actual.height}`;
                    if (isCurrentDisplayed()) {
                        updateSuiteCardResolutionBySlot(slot.index, imageUrl, entry.actualSize);
                    }
                }
                // 单张图片完成后，如果有历史记录 ID，更新它（使用 currentTaskHistoryId 避免被覆盖）
                if (currentTaskHistoryId) {
                    const currentImages = suiteImageMeta.slice().sort((a, b) => a.index - b.index).map(item => ({
                        index: item.index,
                        keyword: item.keyword,
                        imageUrl: item.imageUrl,
                        actualSize: item.actualSize || null
                    }));
                    updateSuiteHistoryInDB(currentTaskHistoryId, {
                        images: currentImages,
                        keywords: currentImages.map(e => e.keyword)
                    });
                }
            });
        };

        try {
            const failedSlots = [];
            await Promise.all(slots.map(slot => runSlot(slot).catch(err => {
                console.error(`卡槽 ${slot.index} 生成失败:`, err);
                failedSlots.push({ index: slot.index, keyword: slot.keyword, error: err.message || String(err || '生成失败') });
                showSlotError(slot.index, err.message);
            })));

            // 获取已生成的图片列表
            const generatedImages = suiteImageMeta.slice().sort((a, b) => a.index - b.index).map(item => ({
                index: item.index,
                keyword: item.keyword,
                imageUrl: item.imageUrl,
                actualSize: item.actualSize || null
            }));
            const successCount = generatedImages.length;
            const failCount = failedSlots.length;
            const notificationStatus = successCount === 0 ? 'failed' : (failCount > 0 ? 'partial' : 'success');
            const notificationTitle = notificationStatus === 'failed'
                ? '套图生图失败'
                : (notificationStatus === 'partial' ? '套图生图部分完成' : '套图生图完成');
            const notificationMessage = notificationStatus === 'success'
                ? `已生成 ${successCount}/${slots.length} 张图片`
                : (notificationStatus === 'partial'
                    ? `已生成 ${successCount}/${slots.length} 张图片，${failCount} 张失败`
                    : `0/${slots.length} 张图片生成成功`);
            const notifySuiteImagesResult = (historyId) => {
                pushTaskResultNotification({
                    historyId,
                    taskId: imageTaskId,
                    taskType: 'suite',
                    stage: 'generate',
                    status: notificationStatus,
                    title: notificationTitle,
                    message: notificationMessage,
                    successCount,
                    failCount,
                    totalCount: slots.length
                });
            };

            // 更新历史记录（前面已经创建或复用）
            if (currentTaskHistoryId) {
                await updateSuiteHistoryInDB(currentTaskHistoryId, {
                    images: generatedImages,
                    keywords: slots.map(s => s.keyword),
                    status: successCount === 0 ? 'images_failed' : (failedSlots.length > 0 ? 'images_partial_failed' : 'completed'),
                    failedSlots: failedSlots.slice().sort((a, b) => a.index - b.index),
                    error: failedSlots.length > 0 ? failedSlots.map(item => `卡槽 ${item.index}: ${item.error}`).join('\n') : ''
                });
                pendingImageTasks.set(imageTaskId, currentTaskHistoryId);
            }
            notifySuiteImagesResult(currentTaskHistoryId);

            // 只有当前任务未被取消时才更新提示
            if (hint.dataset.imageTaskId === imageTaskId) {
                // 清除运行状态
                if (statusKey) clearSuiteRunningStatus(statusKey, imageTaskId);
                // 隐藏 suiteStatusBar
                if (statusBar) statusBar.style.display = 'none';
                
                if (isCurrentDisplayed()) {
                    hint.textContent = `已完成 ${successCount}/${slots.length} 张图片的生成`;
                    hint.style.color = '#10b981';
                } else {
                    hint.textContent = '';
                    if (typeof window.showToast === 'function') {
                        window.showToast(`任务 ${currentTaskHistoryId} 的图片已生成完成`);
                    }
                }
                hint.dataset.imageTaskId = '';
            }
        } catch (error) {
            console.error('生成图片失败:', error);
            if (currentTaskHistoryId) {
                updateSuiteHistoryInDB(currentTaskHistoryId, { status: 'images_failed', error: error.message }).catch(err => {
                    console.warn('更新图片失败状态失败:', err);
                });
            }
            pushTaskResultNotification({
                historyId: currentTaskHistoryId || null,
                taskId: imageTaskId,
                taskType: 'suite',
                stage: 'generate',
                status: 'failed',
                title: '套图生图失败',
                message: error.message || String(error || '生图失败')
            });
            // 只有当前任务未被取消时才更新提示
            if (hint.dataset.imageTaskId === imageTaskId) {
                // 清除运行状态
                if (statusKey) clearSuiteRunningStatus(statusKey, imageTaskId);
                // 隐藏 suiteStatusBar
                if (statusBar) statusBar.style.display = 'none';
                
                hint.textContent = '生成失败: ' + error.message;
                hint.style.color = '#ef4444';
                hint.dataset.imageTaskId = '';
            }
        } finally {
            // 清除运行状态并隐藏 suiteStatusBar
            if (statusKey) clearSuiteRunningStatus(statusKey, imageTaskId);
            if (statusBar) statusBar.style.display = 'none';
            pendingImageTasks.delete(imageTaskId);
            updateBackgroundTaskHint();
        }
    }
    // 解析图片URL
    window.parseImageFromResponse = function parseImageFromResponse(data) {
        if (!data) return null;

        if (typeof data === 'string') {
            const trimmed = data.trim();
            if (!trimmed) return null;
            if (trimmed.startsWith('data:image/')) return trimmed;
            if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
            try {
                const parsed = JSON.parse(trimmed);
                return parseImageFromResponse(parsed);
            } catch (_) {
                return trimmed;
            }
        }

        const directCandidates = [
            data.url,
            data.image_url,
            data.imageUrl,
            data.image,
            data.content,
            data.result
        ];
        for (const candidate of directCandidates) {
            const parsed = parseImageFromResponse(candidate);
            if (parsed) return parsed;
        }

        if (Array.isArray(data.choices) && data.choices.length > 0) {
            const choice = data.choices[0];
            const content = choice?.message?.content ?? choice?.content;
            const parsedContent = parseImageFromResponse(content);
            if (parsedContent) return parsedContent;

            const imgUrl = choice?.message?.image_url || choice?.image_url;
            if (typeof imgUrl === 'string') return imgUrl;
            if (imgUrl?.url) return imgUrl.url;
        }

        if (Array.isArray(data.results) && data.results.length > 0) {
            for (const result of data.results) {
                const nested = parseImageFromResponse(result);
                if (nested) return nested;
            }
        }

        if (data.data) {
            const nested = parseImageFromResponse(data.data);
            if (nested) return nested;
        }

        return null;
    };

    // 切换卡片视图
    function switchSuiteCardView(btn) {
        const card = btn?.closest?.('.suite-card');
        if (!card) return;

        const type = btn.dataset.type;

        // 移除所有active
        card.querySelectorAll('.suite-tab-btn').forEach(b => b.classList.remove('active'));

        // 添加active到当前按钮
        btn.classList.add('active');

        // 切换视图
        card.classList.remove('suite-view-text', 'suite-view-image');
        card.classList.add(type === 'text' ? 'suite-view-text' : 'suite-view-image');
    }

    window.switchSuiteCardView = switchSuiteCardView;

    // 根据比例设置移动端卡片最小宽度（控制列数）
    function getCardMinWidth(ratioStr) {
        if (!ratioStr || !ratioStr.includes(':')) return '140px';
        const parts = ratioStr.split(':').map(Number);
        if (!isFinite(parts[0]) || !isFinite(parts[1]) || parts[1] === 0) return '140px';
        const r = parts[0] / parts[1];
        if (r >= 2.0) return '280px';   // 21:9, 2:1, 3:1 → 手机1列
        if (r >= 1.7) return '200px';   // 16:9 → 手机1列
        return '140px';                  // 其他 → 手机2列
    }

    function buildSlots() {
        const countInput = document.getElementById('suiteCountInput');
        const ratioInput = document.getElementById('suiteRatioInput');
        const sizeInput = document.getElementById('suiteSizeInput');
        const copyInput = document.getElementById('suiteCopyInput');
        const grid = document.getElementById('suiteSlotGrid');
        const hint = document.getElementById('suiteHint');
        if (!countInput || !ratioInput || !sizeInput || !copyInput || !grid || !hint) return;

        let count = parseInt(countInput.value, 10);
        if (!isFinite(count)) count = 1;
        count = clamp(count, 1, 12);
        countInput.value = String(count);

        const ratio = ratioInput.value;
        const imageSize = sizeInput.value;
        const copyText = (copyInput.value || '').trim();
        const target = getTargetResolution(imageSize, ratio);

        const ratioPair = parseRatioText(ratio);
        const cssRatio = ratio === 'auto'
            ? `${Math.max(1, target.width || 1)} / ${Math.max(1, target.height || 1)}`
            : `${ratioPair[0]} / ${ratioPair[1]}`;

        const wideRatio = ratio.includes(':') && (() => {
            const parts = ratio.split(':').map(Number);
            return isFinite(parts[0]) && isFinite(parts[1]) && parts[0] > parts[1];
        })();
        let columns;
        if (wideRatio) {
            columns = count <= 3 ? count : 3;
        } else if (count <= 4) {
            columns = count;
        } else if (count <= 6) {
            columns = 3;
        } else {
            columns = 4;
        }
        columns = Math.min(columns, count);
        grid.dataset.columns = String(columns);
        grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
        // 移动端：根据比例设置卡片最小宽度，CSS auto-fill自动计算列数
        grid.style.setProperty('--card-min-width', getCardMinWidth(ratio));
        grid.innerHTML = '';
        for (let i = 1; i <= count; i++) {
            const card = document.createElement('div');
            card.className = 'suite-card';

            const srcRef = window.suiteFiles.length > 0
                ? `IMG ${(i - 1) % window.suiteFiles.length + 1}`
                : L.noRef;

            card.innerHTML = `
                <div class="suite-card-head">
                    <div class="suite-card-head-row1">
                        <span class="suite-chip">#${i}</span>
                        <button class="suite-gen-single-btn" onclick="generateSingleSlotImage(${i})" title="使用该关键词生成图片">
                            <i class="fas fa-image"></i> 生图
                        </button>
                    </div>
                    <div class="suite-tab-btns">
                        <button class="suite-tab-btn suite-tab-text active" data-type="text" onclick="switchSuiteCardView(this)">关键词</button>
                        <button class="suite-tab-btn suite-tab-image" data-type="image" onclick="switchSuiteCardView(this)">图片</button>
                    </div>
                </div>
                <div class="suite-card-content" style="--slot-ratio:${cssRatio};">
                    <textarea class="suite-text-area" placeholder="输入关键词..." data-index="${i}" style="width:100%;height:100%;resize:none;padding:12px;box-sizing:border-box;border:none;background:#1f2937;color:#f3f4f6;font-size:13px;line-height:1.5;"></textarea>
                    <div class="suite-image-slot">
                        <div>
                            <div style="font-weight:600; margin-bottom:4px;">${L.imageSlot}</div>
                            <div style="font-size:12px;">${L.imageHelp}</div>
                        </div>
                    </div>
                </div>
                <div class="suite-meta">${target.width} x ${target.height}</div>
            `;
            card.classList.add('suite-view-text');
            grid.appendChild(card);
        }

        if (!renderSuiteRunningStatus()) {
            hint.textContent = `${L.createdPrefix}${count}${L.createdSuffix}`;
            hint.style.color = '';
        }
    }

    function updateExistingSlotsRatio() {
        const ratioSel = document.getElementById('suiteRatioInput');
        const sizeInput = document.getElementById('suiteSizeInput');
        if (!ratioSel) return;

        const ratio = ratioSel.value;
        const imageSize = sizeInput ? sizeInput.value : '1K';
        const target = getTargetResolution(imageSize, ratio);
        const ratioPair = parseRatioText(ratio);
        const cssRatio = ratio === 'auto'
            ? `${Math.max(1, target.width || 1)} / ${Math.max(1, target.height || 1)}`
            : `${ratioPair[0]} / ${ratioPair[1]}`;

        // 1. 更新 grid columns 最小列宽
        updateSuiteGridDensity();

        // 2. 动态更新所有现有卡槽的外观比例和分辨率文本
        const cards = document.querySelectorAll('.suite-card');
        cards.forEach(card => {
            const content = card.querySelector('.suite-card-content');
            if (content) {
                content.style.setProperty('--slot-ratio', cssRatio);
            }
            const meta = card.querySelector('.suite-meta');
            if (meta) {
                meta.textContent = `${target.width} x ${target.height}`;
            }
        });
    }

    function buildSuitePage() {
        const nav = document.querySelector('.navbar');
        const mainContainer = document.querySelector('.main-container');
        const body = document.body;
        if (!nav || !mainContainer || !body) return;
        if (document.getElementById('enhSuitePage')) return;

        // 在navbar下方创建tabsWrap，不在navbar内部
        const tabsWrap = document.createElement('div');
        tabsWrap.className = 'page-tabs-wrap';
        tabsWrap.innerHTML = `
            <div class="page-tabs" id="suite-v2-root">
                <button class="page-tab-btn active" id="pageTabRegular">${L.regular}</button>
                <button class="page-tab-btn" id="pageTabSuite">${L.suite}</button>
                <button class="page-tab-btn" id="pageTabChat"><i class="fas fa-comments"></i> 对话</button>
                <button class="chat-menu-btn" id="chatMenuBtn" title="对话历史"><i class="fas fa-bars"></i></button>
            </div>
        `;
        nav.parentNode.insertBefore(tabsWrap, nav.nextSibling);

        const regularPage = document.createElement('div');
        regularPage.className = 'enh-page active';
        regularPage.id = 'enhRegularPage';
        mainContainer.parentNode.insertBefore(regularPage, mainContainer);
        regularPage.appendChild(mainContainer);

        const suitePage = document.createElement('div');
        suitePage.className = 'enh-page';
        suitePage.id = 'enhSuitePage';
        suitePage.innerHTML = `
            <div class="suite-shell">
                <div class="suite-composer" id="suiteDropZone">
                    <button class="suite-collapse-toggle" id="suiteCollapseToggle" title="收起/展开控制区"><i class="fas fa-chevron-down"></i></button>
                    <div class="composer-collapsed-tip" id="suiteCollapsedTip" style="display: none;">
                        <i class="fas fa-keyboard"></i> 点击展开输入控制台...
                    </div>
                    <div class="suite-row">
                        <input type="file" id="suiteFileInput" accept="image/*" multiple style="display:none;">
                        <button class="tool-btn" id="suiteUploadBtn"><i class="fas fa-paperclip"></i> ${L.upload}</button>
                        <label class="suite-count-wrap">${L.count}<input id="suiteCountInput" class="suite-count-input" type="number" min="1" max="12" value="4"></label>
                        <!-- 模型选择 - 使用常规模式的选择器 -->
                        <div class="model-dropdown-wrapper" title="选择生图模型">
                            <div class="model-input-wrapper" onclick="toggleSuiteModelDropdown(event, 'gen')">
                                <input type="text" id="suiteGenModelInput" class="model-input" value="nano-banana-fast" placeholder="输入或选择模型" spellcheck="false" onclick="toggleSuiteModelDropdown(event, 'gen')" oninput="filterSuiteModelOptions('gen')">
                                <button class="model-input-btn" onclick="toggleSuiteModelDropdown(event, 'gen')" title="显示所有模型">
                                    <i class="fas fa-chevron-down"></i>
                                </button>
                            </div>
                            <div class="model-dropdown-menu" id="suiteGenModelMenu">
                                <!-- 图片生成模型 -->
                                <div class="model-dropdown-item selected" data-mode="image-generation" onclick="selectSuiteModel(this, 'gen')">nano-banana-fast</div>
                                <div class="model-dropdown-item" data-mode="image-generation" onclick="selectSuiteModel(this, 'gen')">nano-banana-2</div>
                                <div class="model-dropdown-item" data-mode="image-generation" onclick="selectSuiteModel(this, 'gen')">nano-banana-pro</div>
                                <div class="model-dropdown-item" data-mode="image-generation" onclick="selectSuiteModel(this, 'gen')">nano-banana-pro-vip</div>
                                <div class="model-dropdown-item" data-mode="image-generation" onclick="selectSuiteModel(this, 'gen')">nano-banana-pro-4k-vip</div>
                                <div class="model-dropdown-item" data-mode="image-generation" onclick="selectSuiteModel(this, 'gen')">GPT Image-2</div>
                                <div class="model-dropdown-item" data-mode="image-generation" onclick="selectSuiteModel(this, 'gen')">gpt-image-2-vip</div>
                            </div>
                        </div>
                        <!-- 反推模型选择 -->
                        <div class="model-dropdown-wrapper" title="选择反推模型">
                            <div class="model-input-wrapper" onclick="toggleSuiteModelDropdown(event, 'vl')">
                                <input type="text" id="suiteVLModelInput" class="model-input" value="gemini-3.1-pro" placeholder="输入或选择模型" spellcheck="false" onclick="toggleSuiteModelDropdown(event, 'vl')" oninput="filterSuiteModelOptions('vl')">
                                <button class="model-input-btn" onclick="toggleSuiteModelDropdown(event, 'vl')" title="显示所有模型">
                                    <i class="fas fa-chevron-down"></i>
                                </button>
                            </div>
                            <div class="model-dropdown-menu" id="suiteVLModelMenu">
                                <!-- 图片反推模型 -->
                                <div class="model-dropdown-item selected" data-mode="media-recognition" onclick="selectSuiteModel(this, 'vl')">gemini-3.1-pro</div>
                                <div class="model-dropdown-item" data-mode="media-recognition" onclick="selectSuiteModel(this, 'vl')">gemini-3.1-flash-lite</div>
                                <div class="model-dropdown-item" data-mode="media-recognition" onclick="selectSuiteModel(this, 'vl')">gemini-3.5-flash</div>
                                <div class="model-dropdown-item" data-mode="media-recognition" onclick="selectSuiteModel(this, 'vl')">gpt-5.5</div>
                                <div class="model-dropdown-item" data-mode="media-recognition" data-provider="modelscope" onclick="selectSuiteModel(this, 'vl')">Qwen/Qwen3.5-397B-A17B</div>
                                <div class="model-dropdown-item" data-mode="media-recognition" data-provider="modelscope" onclick="selectSuiteModel(this, 'vl')">moonshotai/Kimi-K2.5</div>
                            </div>
                        </div>
                        <div class="custom-select-wrapper" title="${L.ratio}">
                            <div class="custom-select-btn" onclick="toggleCustomSelect('suiteRatioMenu', event)">
                                <span class="custom-select-value" id="suiteRatioValue">1:1</span>
                                <i class="fas fa-chevron-down"></i>
                            </div>
                            <div class="custom-select-menu" id="suiteRatioMenu" style="bottom: auto; top: calc(100% + 4px);">
                                <div class="custom-select-item selected" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '1:1')">1:1</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '2:3')">2:3</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '3:2')">3:2</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '4:3')">4:3</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '3:4')">3:4</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '16:9')">16:9</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '9:16')">9:16</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '1:2')">1:2</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '2:1')">2:1</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '4:5')">4:5</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '5:4')">5:4</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '21:9')">21:9</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '9:21')">9:21</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '1:3')">1:3</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteRatioMenu', 'suiteRatioValue', 'suiteRatioInput', this, '3:1')">3:1</div>
                            </div>
                            <input type="hidden" id="suiteRatioInput" value="1:1">
                        </div>
                        <div class="custom-select-wrapper" title="${L.size}">
                            <div class="custom-select-btn" onclick="toggleCustomSelect('suiteSizeMenu', event)">
                                <span class="custom-select-value" id="suiteSizeValue">1K</span>
                                <i class="fas fa-chevron-down"></i>
                            </div>
                            <div class="custom-select-menu" id="suiteSizeMenu" style="bottom: auto; top: calc(100% + 4px);">
                                <div class="custom-select-item selected" onclick="selectCustomOption('suiteSizeMenu', 'suiteSizeValue', 'suiteSizeInput', this, '1K')">1K</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteSizeMenu', 'suiteSizeValue', 'suiteSizeInput', this, '2K')">2K</div>
                                <div class="custom-select-item" onclick="selectCustomOption('suiteSizeMenu', 'suiteSizeValue', 'suiteSizeInput', this, '4K')">4K</div>
                            </div>
                            <input type="hidden" id="suiteSizeInput" value="1K">
                        </div>
                        <button class="generate-btn" id="suiteBuildBtn"><i class="fas fa-layer-group"></i> ${L.build}</button>
                        <button class="generate-btn" id="suiteNewTaskBtn" style="background:linear-gradient(135deg,#f87171,#e05252);"><i class="fas fa-plus"></i> 新建任务</button>
                        <button class="generate-btn" id="suiteGenKeywordsBtn" style="background:linear-gradient(135deg,#f59e0b,#d97706);"><i class="fas fa-magic"></i> 生成关键词</button>
                        <button class="generate-btn" id="suiteGenImagesBtn" style="background:linear-gradient(135deg,#10b981,#059669);"><i class="fas fa-image"></i> 生成图片</button>
                        <button class="generate-btn" id="suiteArchiveCurrentBtn" style="background:linear-gradient(135deg,#0ea5e9,#0284c7);"><i class="fas fa-box-archive"></i> 归档当前套图</button>
                        <span id="suiteBackgroundBadge" style="display:none;font-size:11px;color:#f59e0b;font-weight:600;padding:3px 8px;background:rgba(245,158,11,.12);border-radius:6px;"></span>
                        <span id="suiteHint" style="font-size:12px;color:var(--text-sub);"></span>
                    </div>
                    <div id="suiteStatusBar" style="display:none;padding:8px 12px;border-radius:8px;background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.4);color:#d97706;font-size:13px;font-weight:600;display:none;align-items:center;gap:8px;">
                        <i class="fas fa-spinner fa-spin"></i>
                        <span id="suiteStatusBarText"></span>
                    </div>
                    <textarea id="suiteCopyInput" class="suite-copy" placeholder="${L.copyPlaceholder}"></textarea>
                    <!-- 原始回传结果显示在预览图区域 -->
                    <div id="suiteRawResponse" style="display:none; padding:10px; background:#1a1a2e; border:1px solid #ff6b6b; border-radius:8px; color:#fff; font-size:12px; max-height:150px; overflow-y:auto;">
                        <div style="font-weight:bold; margin-bottom:6px; color:#ff6b6b; display:flex; align-items:center; gap:4px; font-size:11px;">
                            <i class="fas fa-code"></i> 原始回传：
                        </div>
                        <pre id="suiteRawText" style="white-space:pre-wrap; word-break:break-all; margin:0;"></pre>
                    </div>
                    <div class="suite-preview-row" id="suitePreviewRow"></div>
                </div>
                <div class="suite-scroll">
                    <div class="suite-grid" id="suiteSlotGrid">
                        <div class="suite-empty"><i class="fas fa-images"></i><div>${L.wait}</div></div>
                    </div>
                </div>
            </div>
        `;
        regularPage.insertAdjacentElement('afterend', suitePage);

        // ==================== 对话模式页面 ====================
        const chatPage = document.createElement('div');
        chatPage.className = 'enh-page';
        chatPage.id = 'enhChatPage';
        chatPage.innerHTML = `
            <div class="chat-shell">
                <!-- 左侧栏 -->
                <div class="chat-sidebar" id="chatSidebar">
                    <div class="chat-sidebar-top">
                        <button class="chat-new-btn" id="chatNewBtn"><i class="fas fa-plus"></i> 新对话</button>
                    </div>
                    <div class="chat-sidebar-list" id="chatSidebarList">
                        <div class="chat-history-item active">
                            <span class="chat-history-title">新对话</span>
                            <button class="chat-history-del" title="删除"><i class="fas fa-times"></i></button>
                        </div>
                    </div>
                    <div class="chat-sidebar-bottom">
                        <button class="chat-clear-btn" id="chatClearBtn"><i class="fas fa-trash-alt"></i> 清空历史</button>
                    </div>
                </div>
                <!-- 侧边栏遮罩（移动端） -->
                <div class="chat-sidebar-overlay" id="chatSidebarOverlay"></div>
                <!-- 下拉菜单遮罩（移动端） -->
                <div class="chat-select-overlay" id="chatSelectOverlay"></div>
                <!-- 右侧对话区 -->
                <div class="chat-main">
                    <!-- 对话消息区 -->
                    <div class="chat-messages" id="chatMessages">
                        <div class="chat-welcome">
                            <p>你好，有什么可以帮你的？</p>
                        </div>
                    </div>
                    <!-- 输入区 -->
                    <div class="chat-input-area">
                        <div class="chat-input-box" id="chatInputBox">
                            <!-- 折叠按钮和折叠提示，仅在手机端启用 -->
                            <button class="chat-collapse-toggle" id="chatCollapseToggle" title="收起/展开控制区">
                                <i class="fas fa-chevron-down"></i>
                            </button>
                            <div class="chat-collapsed-tip" id="chatCollapsedTip" style="display: none;">
                                <i class="fas fa-comment-dots"></i> 点击展开对话控制台...
                            </div>
                            <div class="chat-input-tools">
                                <button class="chat-tool-btn" id="chatUploadBtn" title="上传图片"><i class="fas fa-paperclip"></i></button>
                                <div class="chat-model-select chat-quick-select" data-kind="chat-model">
                                    <span class="chat-model-label">对话模型</span>
                                    <div class="custom-select-wrapper">
                                        <div class="custom-select-btn" onclick="toggleCustomSelect('chatModelMenu', event)">
                                            <span class="custom-select-value" id="chatModelValue">Qwen/Qwen3.5-397B-A17B</span>
                                            <i class="fas fa-chevron-down"></i>
                                        </div>
                                        <div class="custom-select-menu" id="chatModelMenu">
                                            <div class="custom-select-item selected" onclick="selectCustomOption('chatModelMenu', 'chatModelValue', 'chatModelSelect', this, 'Qwen/Qwen3.5-397B-A17B')">Qwen/Qwen3.5-397B-A17B</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatModelMenu', 'chatModelValue', 'chatModelSelect', this, 'gemini-3.1-pro')">gemini-3.1-pro</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatModelMenu', 'chatModelValue', 'chatModelSelect', this, 'gemini-3.1-flash-lite')">gemini-3.1-flash-lite</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatModelMenu', 'chatModelValue', 'chatModelSelect', this, 'gemini-3.5-flash')">gemini-3.5-flash</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatModelMenu', 'chatModelValue', 'chatModelSelect', this, 'gpt-5.5')">gpt-5.5</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatModelMenu', 'chatModelValue', 'chatModelSelect', this, 'moonshotai/Kimi-K2.5')">moonshotai/Kimi-K2.5</div>
                                        </div>
                                        <input type="hidden" id="chatModelSelect" value="Qwen/Qwen3.5-397B-A17B">
                                    </div>
                                </div>
                                <div class="chat-model-select chat-quick-select" data-kind="chat-image-model">
                                    <span class="chat-model-label">生图模型</span>
                                    <div class="custom-select-wrapper">
                                        <div class="custom-select-btn" onclick="toggleCustomSelect('chatImageModelMenu', event)">
                                            <span class="custom-select-value" id="chatImageModelValue">GPT Image-2</span>
                                            <i class="fas fa-chevron-down"></i>
                                        </div>
                                        <div class="custom-select-menu" id="chatImageModelMenu">
                                            <div class="custom-select-item selected" onclick="selectCustomOption('chatImageModelMenu', 'chatImageModelValue', 'chatImageModelSelect', this, 'GPT Image-2')">GPT Image-2</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatImageModelMenu', 'chatImageModelValue', 'chatImageModelSelect', this, 'gpt-image-2-vip')">gpt-image-2-vip</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatImageModelMenu', 'chatImageModelValue', 'chatImageModelSelect', this, 'nano-banana-fast')">nano-banana-fast</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatImageModelMenu', 'chatImageModelValue', 'chatImageModelSelect', this, 'nano-banana-2')">nano-banana-2</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatImageModelMenu', 'chatImageModelValue', 'chatImageModelSelect', this, 'nano-banana-pro')">nano-banana-pro</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatImageModelMenu', 'chatImageModelValue', 'chatImageModelSelect', this, 'nano-banana-pro-vip')">nano-banana-pro-vip</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatImageModelMenu', 'chatImageModelValue', 'chatImageModelSelect', this, 'nano-banana-pro-4k-vip')">nano-banana-pro-4k-vip</div>
                                        </div>
                                        <input type="hidden" id="chatImageModelSelect" value="GPT Image-2">
                                    </div>
                                </div>
                                <div class="chat-model-select chat-quick-select" data-kind="chat-ratio">
                                    <span class="chat-model-label">比例</span>
                                    <div class="custom-select-wrapper chat-auto-width">
                                        <div class="custom-select-btn" onclick="toggleCustomSelect('chatAspectRatioMenu', event)">
                                            <span class="custom-select-value" id="chatAspectRatioValue">自动</span>
                                            <i class="fas fa-chevron-down"></i>
                                        </div>
                                        <div class="custom-select-menu" id="chatAspectRatioMenu">
                                            <div class="custom-select-item selected" onclick="selectCustomOption('chatAspectRatioMenu', 'chatAspectRatioValue', 'chatAspectRatioSelect', this, 'auto')">自动</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatAspectRatioMenu', 'chatAspectRatioValue', 'chatAspectRatioSelect', this, '1:1')">1:1（正方形）</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatAspectRatioMenu', 'chatAspectRatioValue', 'chatAspectRatioSelect', this, '2:3')">2:3（竖向海报）</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatAspectRatioMenu', 'chatAspectRatioValue', 'chatAspectRatioSelect', this, '3:2')">3:2（横向照片）</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatAspectRatioMenu', 'chatAspectRatioValue', 'chatAspectRatioSelect', this, '4:3')">4:3（标准横向）</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatAspectRatioMenu', 'chatAspectRatioValue', 'chatAspectRatioSelect', this, '5:4')">5:4（近方横向）</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatAspectRatioMenu', 'chatAspectRatioValue', 'chatAspectRatioSelect', this, '16:9')">16:9（宽屏横向）</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatAspectRatioMenu', 'chatAspectRatioValue', 'chatAspectRatioSelect', this, '3:4')">3:4（标准竖向）</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatAspectRatioMenu', 'chatAspectRatioValue', 'chatAspectRatioSelect', this, '4:5')">4:5（近方竖向）</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatAspectRatioMenu', 'chatAspectRatioValue', 'chatAspectRatioSelect', this, '9:16')">9:16（宽屏竖向）</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatAspectRatioMenu', 'chatAspectRatioValue', 'chatAspectRatioSelect', this, '21:9')">21:9（超宽屏）</div>
                                        </div>
                                        <input type="hidden" id="chatAspectRatioSelect" value="auto">
                                    </div>
                                </div>
                                <div class="chat-model-select chat-quick-select" data-kind="chat-size">
                                    <span class="chat-model-label">尺寸</span>
                                    <div class="custom-select-wrapper">
                                        <div class="custom-select-btn" onclick="toggleCustomSelect('chatImageSizeMenu', event)">
                                            <span class="custom-select-value" id="chatImageSizeValue">1K</span>
                                            <i class="fas fa-chevron-down"></i>
                                        </div>
                                        <div class="custom-select-menu" id="chatImageSizeMenu">
                                            <div class="custom-select-item selected" onclick="selectCustomOption('chatImageSizeMenu', 'chatImageSizeValue', 'chatImageSizeSelect', this, '1K')">1K</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatImageSizeMenu', 'chatImageSizeValue', 'chatImageSizeSelect', this, '2K')">2K</div>
                                            <div class="custom-select-item" onclick="selectCustomOption('chatImageSizeMenu', 'chatImageSizeValue', 'chatImageSizeSelect', this, '4K')">4K</div>
                                        </div>
                                        <input type="hidden" id="chatImageSizeSelect" value="1K">
                                    </div>
                                </div>
                                <div class="chat-toggle-row">
                                    <label class="chat-toggle-label">
                                        <input type="checkbox" id="chatImageGenToggle" checked>
                                        <span class="chat-toggle-switch"></span>
                                        <span class="chat-toggle-text">启用生图</span>
                                    </label>
                                </div>
                            </div>
                            <div class="chat-input-row">
                                <div class="chat-input-content">
                                    <div class="chat-images-preview" id="chatImagesPreview"></div>
                                    <textarea id="chatInput" rows="2" placeholder="输入消息..."></textarea>
                                </div>
                                <button class="chat-send-btn" id="chatSendBtn"><i class="fas fa-paper-plane"></i></button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        suitePage.insertAdjacentElement('afterend', chatPage);

        document.getElementById('pageTabRegular').addEventListener('click', () => switchPage('regular'));
        document.getElementById('pageTabSuite').addEventListener('click', () => switchPage('suite'));
        document.getElementById('pageTabChat').addEventListener('click', () => switchPage('chat'));

        const fileInput = document.getElementById('suiteFileInput');
        const uploadBtn = document.getElementById('suiteUploadBtn');
        const buildBtn = document.getElementById('suiteBuildBtn');
        const ratioInput = document.getElementById('suiteRatioInput');
        const countInput = document.getElementById('suiteCountInput');
        const dropZone = document.getElementById('suiteDropZone');
        const copyInput = document.getElementById('suiteCopyInput');

        uploadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            addSuiteFiles(Array.from(fileInput.files || []).filter(f => (f.type || '').startsWith('image/')));
            fileInput.value = '';
        });
        buildBtn.addEventListener('click', buildSlots);
        if (ratioInput) {
            ratioInput.addEventListener('change', updateExistingSlotsRatio);
        }
        document.getElementById('suiteGenKeywordsBtn').addEventListener('click', generateSuiteKeywords);
        document.getElementById('suiteGenImagesBtn').addEventListener('click', generateSuiteImages);
        document.getElementById('suiteNewTaskBtn').addEventListener('click', suiteNewTask);
        document.getElementById('suiteArchiveCurrentBtn').addEventListener('click', archiveCurrentSuiteFromPage);
        const toggleSuiteCollapse = (e) => {
            if (e) e.stopPropagation();
            const composer = document.getElementById('suiteDropZone');
            if (!composer) return;
            const isCollapsed = composer.classList.toggle('suite-collapsed');
            
            // 更新提示可见性
            const tip = document.getElementById('suiteCollapsedTip');
            if (tip) {
                tip.style.display = isCollapsed ? 'flex' : 'none';
            }
        };

        document.getElementById('suiteCollapseToggle').addEventListener('click', toggleSuiteCollapse);
        
        // 点击折叠态的套图输入区域时，自动展开
        document.getElementById('suiteDropZone').addEventListener('click', (e) => {
            const composer = document.getElementById('suiteDropZone');
            if (composer && composer.classList.contains('suite-collapsed')) {
                e.preventDefault();
                e.stopPropagation();
                toggleSuiteCollapse(e);
            }
        });
        // 移动端：点击外部关闭模型下拉弹出框
        document.addEventListener('click', (e) => {
            if (window.innerWidth > 768) return;
            const openMenus = document.querySelectorAll('.suite-composer .model-dropdown-menu.show');
            if (openMenus.length === 0) return;
            let clickedInside = false;
            openMenus.forEach(menu => {
                const wrapper = menu.closest('.model-dropdown-wrapper');
                if (wrapper && wrapper.contains(e.target)) clickedInside = true;
            });
            if (!clickedInside) {
                openMenus.forEach(m => m.classList.remove('show'));
                toggleSuiteMobileBackdrop(false);
            }
        });
        ratioInput.addEventListener('change', () => {
            updateSuiteGridDensity();
            buildSlots();
        });
        document.getElementById('suiteSizeInput').addEventListener('change', buildSlots);
        countInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') buildSlots(); });

        copyInput.addEventListener('paste', (e) => {
            const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items || [];
            const files = [];
            for (const item of items) {
                if (item.kind === 'file' && (item.type || '').startsWith('image/')) files.push(item.getAsFile());
            }
            if (files.length > 0) {
                e.preventDefault();
                addSuiteFiles(files);
            }
        });

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('drag-over');
        });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            addSuiteFiles(Array.from(e.dataTransfer.files || []).filter(f => (f.type || '').startsWith('image/')));
        });

        // Prevent original body wheel handler from hijacking suite page scroll
        document.body.addEventListener('wheel', (e) => {
            if (activePage === 'suite') e.stopPropagation();
        }, { capture: true });

        window.__suiteRemoveFile = function (idx) {
            window.suiteFiles.splice(idx, 1);
            renderSuitePreviews();
        };
        window.__suiteRestoreFilesFromHistory = restoreSuiteFilesFromHistory;

        updateSuiteGridDensity();
    }

    // ========== 多用户免密登记与安全隔离前端逻辑 ==========
    async function checkUserRegistration() {
        if (!StorageAdapter.isServer()) {
            console.log('🔌 [Loirs Multi-User]: 处于 IndexedDB 离线存储模式，跳过局域网多用户初始化。');
            return;
        }

        // 1. 初始化 Client ID
        let clientId = localStorage.getItem('clientId');
        if (!clientId) {
            clientId = 'cli_' + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
            localStorage.setItem('clientId', clientId);
        }
        console.log(`🔌 [Loirs Multi-User]: 当前设备指纹 ClientId 为: "${clientId}"`);

        try {
            console.log('🔌 [Loirs Multi-User]: 正在向后端嗅探本机 IP 归属状态...');
            const statusRes = await fetch('/api/status');
            const statusData = await statusRes.json();
            console.log('🔌 [Loirs Multi-User]: 后端嗅探状态成功，结果为:', statusData);
            
            if (statusData.isLocal) {
                console.log('👑 [Loirs Multi-User]: 本机被认定为【超级管理员】，执行静默配置并秒级注入筛选。');
                localStorage.setItem('clientId', 'local_admin');
                localStorage.setItem('username', '本机管理员');
                
                // 100% 优先、无延迟地去渲染管理员专属历史过滤下拉框（不等待网络，解耦防卡死）
                renderAdminUserFilter();

                // 异步在 users.json 中登记，确保花名册正常，不阻塞前台渲染
                fetch('/api/register-user', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId: 'local_admin', username: '本机管理员' })
                }).catch(e => console.error('👑 管理员异步登记失败:', e));
                
                return;
            }

            // 3. 局域网同事：检查是否有已存的有效笔名
            let username = localStorage.getItem('username');
            console.log(`👤 [Loirs Multi-User]: 本地保存的笔名为: "${username}"`);
            if (username && username !== '本机管理员') {
                console.log('👤 [Loirs Multi-User]: 正在向服务器校验该笔名是否仍可合法通行...');
                const regRes = await fetch('/api/register-user', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId, username })
                });
                const regData = await regRes.json();
                if (regData.success) {
                    console.log('👤 [Loirs Multi-User]: 笔名验证成功，进入抽屉头部渲染流程。');
                    renderUserTagInHeader(username);
                    return;
                } else {
                    console.log('⚠️ [Loirs Multi-User]: 笔名失效或重名被占领，擦除缓存准备重新登记。');
                    localStorage.removeItem('username');
                }
            }

            // 4. 需要拉起必填登记窗
            console.log('🔒 [Loirs Multi-User]: 需要强力拉起免密名字登记弹窗。');
            showRegistrationModal(clientId);
        } catch (e) {
            console.error('❌ 初始化多用户状态失败:', e);
        }
    }

    function showRegistrationModal(clientId) {
        if (document.getElementById('loisRegisterModal')) return;

        const modal = document.createElement('div');
        modal.id = 'loisRegisterModal';
        modal.style = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(15, 23, 42, 0.7);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 999999;
            animation: fadeIn 0.3s ease;
        `;

        const card = document.createElement('div');
        card.style = `
            background: var(--bg-card, #1f2937);
            border: 1px solid var(--border, #374151);
            border-radius: 16px;
            padding: 30px;
            width: 90%;
            max-width: 400px;
            box-shadow: 0 12px 36px rgba(0, 0, 0, 0.4);
            color: var(--text-main, #f9fafb);
            text-align: center;
            transform: scale(0.95);
            animation: scaleUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        `;

        if (!document.getElementById('loisRegisterAnims')) {
            const style = document.createElement('style');
            style.id = 'loisRegisterAnims';
            style.innerHTML = `
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                @keyframes scaleUp { to { transform: scale(1); } }
            `;
            document.head.appendChild(style);
        }

        card.innerHTML = `
            <div style="font-size: 36px; margin-bottom: 15px; color: var(--primary, #6366f1);">
                <i class="fas fa-palette"></i>
            </div>
            <h3 style="font-size: 20px; font-weight: 700; margin-bottom: 12px; color: var(--text-main);">🎨 欢迎使用 Loirs 绘图终端</h3>
            <p style="font-size: 13px; color: var(--text-sub, #9ca3af); line-height: 1.6; margin-bottom: 22px; text-align: left; padding: 0 10px;">
                首次加入平台，请输入您的<b>名字作为生图笔名</b>：这有利于同事之间识别作品所有人，防止劳动成果被误删，也用来实现您专属的历史记录隔离。
            </p>
            <div style="position: relative; margin-bottom: 15px;">
                <input type="text" id="loisRegInput" placeholder="请输入您的真实姓名或笔名" style="
                    width: 100%;
                    padding: 12px 16px;
                    border-radius: 8px;
                    background: var(--bg-body, #111827);
                    border: 1px solid var(--border, #374151);
                    color: var(--text-main, #f9fafb);
                    font-size: 14px;
                    outline: none;
                    box-sizing: border-box;
                    text-align: center;
                    transition: border-color 0.2s;
                " maxlength="10" />
            </div>
            <div id="loisRegError" style="color: #f87171; font-size: 12px; margin-bottom: 15px; min-height: 18px; display: none;"></div>
            <button id="loisRegBtn" style="
                width: 100%;
                padding: 12px;
                border: none;
                border-radius: 8px;
                background: linear-gradient(135deg, var(--primary, #6366f1), var(--primary-hover, #4f46e5));
                color: white;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
                transition: transform 0.1s, opacity 0.2s;
            ">登记并进入</button>
        `;

        modal.appendChild(card);
        document.body.appendChild(modal);

        const input = card.querySelector('#loisRegInput');
        const btn = card.querySelector('#loisRegBtn');
        const err = card.querySelector('#loisRegError');

        input.focus();

        input.addEventListener('input', () => {
            err.style.display = 'none';
            input.style.borderColor = 'var(--border)';
        });

        const submitReg = async () => {
            const username = input.value.trim();
            if (!username) {
                err.innerText = '⚠️ 笔名不能为空';
                err.style.display = 'block';
                input.style.borderColor = '#f87171';
                return;
            }

            if (username.length < 2 || username.length > 10) {
                err.innerText = '⚠️ 长度必须在 2 到 10 个字之间';
                err.style.display = 'block';
                input.style.borderColor = '#f87171';
                return;
            }

            if (/^\d+$/.test(username)) {
                err.innerText = '⚠️ 笔名不能是纯数字，请使用汉字或英文昵称';
                err.style.display = 'block';
                input.style.borderColor = '#f87171';
                return;
            }

            btn.disabled = true;
            btn.innerText = '登记中...';

            try {
                const res = await fetch('/api/register-user', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId, username })
                });
                const data = await res.json();
                if (data.success) {
                    localStorage.setItem('username', username);
                    modal.remove();
                    renderUserTagInHeader(username);
                    loadHistoryPage(1);
                } else {
                    err.innerText = '⚠️ ' + (data.error || '登记失败，请重试');
                    err.style.display = 'block';
                    input.style.borderColor = '#f87171';
                    btn.disabled = false;
                    btn.innerText = '登记并进入';
                }
            } catch (e) {
                err.innerText = '❌ 无法连接到本地服务器';
                err.style.display = 'block';
                btn.disabled = false;
                btn.innerText = '登记并进入';
            }
        };

        btn.addEventListener('click', submitReg);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitReg();
        });
    }

    function showRenameModal() {
        const clientId = localStorage.getItem('clientId');
        if (!clientId || clientId === 'local_admin') return;
        const currentName = localStorage.getItem('username') || '';

        const newName = prompt('📝 请输入您要修改的绘图笔名：\n(2-10个字，不能为纯数字且不能与他人重复)', currentName);
        if (newName === null) return;
        const cleaned = newName.trim();
        if (!cleaned) {
            alert('笔名不能为空！');
            return;
        }
        if (cleaned === currentName) return;

        if (cleaned.length < 2 || cleaned.length > 10) {
            alert('笔名长度必须在 2 到 10 个字之间！');
            return;
        }

        if (/^\d+$/.test(cleaned)) {
            alert('笔名不能是纯数字！');
            return;
        }

        fetch('/api/register-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId, username: cleaned })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                localStorage.setItem('username', cleaned);
                renderUserTagInHeader(cleaned);
                alert('🎉 笔名修改成功！新署名已生效！');
                loadHistoryPage(1);
            } else {
                alert('❌ 修改失败：' + (data.error || '重名校验未通过'));
            }
        })
        .catch(() => {
            alert('❌ 无法连接到服务器');
        });
    }

    function renderUserTagInHeader(username) {
        console.log(`👤 [Loirs Multi-User]: renderUserTagInHeader 被调用，待渲染笔名: "${username}"。启动 DOM 轮询探测...`);
        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;
            const drawerHeader = document.querySelector('.drawer-header');
            const closeBtn = document.querySelector('.close-drawer');
            
            if (drawerHeader && closeBtn) {
                clearInterval(interval);
                console.log('👤 [Loirs Multi-User]: 轮询成功：成功捕捉到历史侧边栏标题节点！正在向侧边栏头部注入笔名徽章...');
                
                let badge = document.getElementById('colleaguePenNameBadge');
                if (!badge) {
                    badge = document.createElement('span');
                    badge.id = 'colleaguePenNameBadge';
                    badge.style = `
                        font-size: 11px;
                        color: var(--text-sub, #9ca3af);
                        background: var(--bg-card, #1f2937);
                        border: 1px solid var(--border, #374151);
                        padding: 4px 8px;
                        border-radius: 6px;
                        cursor: pointer;
                        margin-left: auto;
                        margin-right: 10px;
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        font-weight: 500;
                        box-shadow: var(--shadow-sm);
                        transition: border-color 0.2s;
                        z-index: 10;
                    `;
                    drawerHeader.insertBefore(badge, closeBtn);
                }
                badge.innerHTML = `<i class="fas fa-user-edit" style="color: var(--primary);"></i> 笔名: ${username}`;
                
                badge.removeEventListener('click', showRenameModal);
                badge.addEventListener('click', showRenameModal);
                
                badge.addEventListener('mouseenter', () => { badge.style.borderColor = 'var(--primary)'; });
                badge.addEventListener('mouseleave', () => { badge.style.borderColor = 'var(--border)'; });
                return;
            }
            
            if (attempts > 50) {
                clearInterval(interval);
                console.error('❌ [Loirs Multi-User]: 轮询 5 秒（50次）超时，未能找到历史侧边栏头部 .drawer-header 元素！');
            }
        }, 100);
    }

    function handleAdminFilterChange() {
        loadHistoryPage(1);
    }

    function renderAdminUserFilter() {
        console.log('👑 [Loirs Multi-User]: renderAdminUserFilter 被调用，超级管理员专属。启动 DOM 轮询探测...');
        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;
            const drawerHeader = document.querySelector('.drawer-header');
            const closeBtn = document.querySelector('.close-drawer');
            
            if (drawerHeader && closeBtn) {
                clearInterval(interval);
                console.log('👑 [Loirs Multi-User]: 轮询成功：成功捕捉到历史侧边栏标题节点！正在向侧边栏头部注入超级管理员筛选框...');
                
                let select = document.getElementById('adminUserFilter');
                if (!select) {
                    select = document.createElement('select');
                    select.id = 'adminUserFilter';
                    select.style = `
                        font-size: 11px;
                        background: var(--bg-card, #1f2937);
                        color: var(--text-main, #f9fafb);
                        border: 1px solid var(--border, #374151);
                        padding: 4px 8px;
                        border-radius: 6px;
                        outline: none;
                        cursor: pointer;
                        margin-left: auto;
                        margin-right: 10px;
                        font-weight: 500;
                        box-shadow: var(--shadow-sm);
                        max-width: 130px;
                        z-index: 10;
                    `;
                    drawerHeader.insertBefore(select, closeBtn);
                }

                console.log('👑 [Loirs Multi-User]: 正在从后端拉取花名册以填装下拉框...');
                // 异步获取当前已登记的花名册，装填到筛选下拉框中
                fetch('/api/get-users')
                    .then(res => res.json())
                    .then(users => {
                        console.log('👑 [Loirs Multi-User]: 后端花名册获取成功:', users);
                        select.innerHTML = `
                            <option value="all">👥 所有人</option>
                            <option value="local_admin">👑 我自己</option>
                        `;
                        Object.entries(users).forEach(([uid, name]) => {
                            if (uid !== 'local_admin') {
                                const opt = document.createElement('option');
                                opt.value = uid;
                                opt.innerText = `👤 ${name}`;
                                select.appendChild(opt);
                            }
                        });
                        
                        // 绑定筛选事件
                        select.removeEventListener('change', handleAdminFilterChange);
                        select.addEventListener('change', handleAdminFilterChange);
                    })
                    .catch(e => console.error('❌ 加载花名册失败:', e));
                return;
            }
            
            if (attempts > 50) {
                clearInterval(interval);
                console.error('❌ [Loirs Multi-User]: 轮询 5 秒（50次）超时，未能找到超级管理员可用的 .drawer-header 元素！');
            }
        }, 100);
    }

    function init() {
        ensureStyles();
        buildSuitePage();
        syncChatLayoutMetrics();
        window.addEventListener('resize', syncChatLayoutMetrics);

        // 初始化对话模式
        initChatMode();

        // 暴露套图相关函数到全局作用域
        window.generateSingleSlotImage = function(slotIndex) {
            generateSingleSlotImage(slotIndex);
        };
        window.switchPage = switchPage;
        window.buildSlots = buildSlots;
        window.suiteNewTask = suiteNewTask;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

// ==================== 拆分代码段 ====================

(() => {
    const previousReuse = window.reuseHistoryItemById;
    let suiteHistoryApplyToken = 0;

    function getHistoryDb() {
        try {
            if (typeof db !== 'undefined' && db) return db;
        } catch (e) {}
        return window.db || null;
    }

    function getStoreName() {
        try {
            if (typeof STORE_NAME !== 'undefined' && STORE_NAME) return STORE_NAME;
        } catch (e) {}
        return window.STORE_NAME || null;
    }

    function notify(msg) {
        if (typeof window.showToast === 'function') {
            window.showToast(msg);
        } else {
            alert(msg);
        }
    }

    async function readHistory(itemId) {
        if (StorageAdapter.isServer()) {
            try {
                const item = await readHistoryItemById(itemId);
                return item;
            } catch (err) {
                console.error("Server readHistory failed:", err);
            }
        }
        return new Promise((resolve, reject) => {
            const historyDb = getHistoryDb();
            const storeName = getStoreName();
            if (!historyDb || !storeName) {
                reject(new Error('history db not ready'));
                return;
            }
            try {
                const tx = historyDb.transaction([storeName], 'readonly');
                const req = tx.objectStore(storeName).get(Number(itemId));
                req.onsuccess = (e) => resolve(e.target.result || null);
                req.onerror = () => reject(new Error('read history failed'));
            } catch (err) {
                reject(err);
            }
        });
    }

    function toSuitePage() {
        if (typeof window.switchPage === 'function') {
            window.switchPage('suite');
            return;
        }
        const suiteBtn = document.getElementById('pageTabSuite');
        if (suiteBtn) suiteBtn.click();
    }

    function waitCards(expectCount) {
        return new Promise((resolve) => {
            const started = Date.now();
            const poll = () => {
                const cards = Array.from(document.querySelectorAll('.suite-card'));
                if (cards.length >= expectCount || Date.now() - started > 2200) {
                    resolve(cards);
                    return;
                }
                setTimeout(poll, 60);
            };
            poll();
        });
    }

    function setCardMode(card, mode) {
        const isImage = mode === 'image';
        card.classList.remove('suite-view-text', 'suite-view-image');
        card.classList.add(isImage ? 'suite-view-image' : 'suite-view-text');
        card.querySelectorAll('.suite-tab-btn').forEach((btn) => btn.classList.remove('active'));
        const active = card.querySelector(isImage ? '.suite-tab-image' : '.suite-tab-text');
        if (active) active.classList.add('active');
    }

    function setCardImage(card, url, titleText) {
        const slot = card.querySelector('.suite-image-slot');
        if (!slot || !url) return;
        slot.innerHTML = '';
        const img = document.createElement('img');
        img.src = url;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        img.style.cursor = 'zoom-in';
        img.onclick = (e) => {
            e.stopPropagation();
            if (typeof window.openPreviewFromUrl === 'function') {
                window.openPreviewFromUrl(url, titleText || '');
            }
        };
        slot.appendChild(img);
    }

    async function applySuiteHistory(itemId, showImages) {
        const applyToken = ++suiteHistoryApplyToken;
        let item = null;
        try {
            item = await readHistory(itemId);
        } catch (err) {
            notify('\u5386\u53f2\u8bb0\u5f55\u8bfb\u53d6\u5931\u8d25');
            return;
        }

        if (!item) {
            notify('\u672a\u627e\u5230\u8be5\u5386\u53f2\u8bb0\u5f55');
            return;
        }
        if (item.type !== 'suite') {
            if (typeof previousReuse === 'function') {
                previousReuse(itemId);
            } else {
                notify('\u8be5\u8bb0\u5f55\u4e0d\u662f\u5957\u56fe\u8bb0\u5f55');
            }
            return;
        }

        if (typeof window.__suiteSetHistoryContext === 'function') {
            window.__suiteSetHistoryContext(itemId, true); // readOnly=true，顶部集体操作时新建记录
        } else {
            window.currentSuiteHistoryId = itemId;
            window.currentDisplayedSuiteHistoryId = itemId;
            window.currentSuiteHistoryReadOnly = true;
        }
        toSuitePage();
        if (applyToken !== suiteHistoryApplyToken) return;
        const grid = document.getElementById('suiteSlotGrid');
        if (grid) {
            grid.innerHTML = '';
            grid.dataset.columns = '';
            grid.style.gridTemplateColumns = '';
        }

        const images = Array.isArray(item.images) ? item.images.slice() : [];
        const keywords = Array.isArray(item.keywords) ? item.keywords.slice() : [];
        const failedSlots = Array.isArray(item.failedSlots) ? item.failedSlots.slice() : [];
        debugLog('套图历史真实恢复路径:', {
            id: item.id || itemId,
            archiveStatus: item.archiveStatus || '',
            archiveCode: item.archiveCode || '',
            archiveFolderName: item.archiveFolderName || '',
            imagesCount: images.length,
            firstImageIsRemote: !!item.firstImage && String(item.firstImage).startsWith('http')
        });
        const imageByIndex = new Map();
        const failedByIndex = new Map();
        images.forEach((img, idx) => {
            const slotIndex = parseInt(img?.index, 10) || (idx + 1);
            imageByIndex.set(slotIndex, img);
        });
        failedSlots.forEach((failed) => {
            const slotIndex = parseInt(failed?.index, 10);
            if (slotIndex) failedByIndex.set(slotIndex, failed);
        });
        while (keywords.length < images.length) {
            keywords.push(images[keywords.length] && images[keywords.length].keyword ? images[keywords.length].keyword : '');
        }
        failedSlots.forEach((failed) => {
            const slotIndex = parseInt(failed?.index, 10);
            if (slotIndex && failed?.keyword && !keywords[slotIndex - 1]) keywords[slotIndex - 1] = failed.keyword;
        });

        // 只信任数据库中的值，不混入当前 UI 的残留值！
        // 优先级：item.count > keywords.length > images.length > 默认4
        const count = item.count || keywords.length || images.length || failedSlots.length || 4;
        const countInput = document.getElementById('suiteCountInput');
        const ratioInput = document.getElementById('suiteRatioInput');
        const sizeInput = document.getElementById('suiteSizeInput');
        const copyInput = document.getElementById('suiteCopyInput');
        const genModelInput = document.getElementById('suiteGenModelInput');
        const vlModelInput = document.getElementById('suiteVLModelInput');

        if (countInput) countInput.value = String(count);
        safeSetSelect(ratioInput, item.ratio || '1:1', '1:1');
        safeSetSelect(sizeInput, item.size || '1K', '1K');
        if (copyInput) copyInput.value = item.rule || item.prompt || '';
        if (genModelInput && item.model) genModelInput.value = item.model;
        if (vlModelInput && item.vlModel) vlModelInput.value = item.vlModel;

        const rawResponseDiv = document.getElementById('suiteRawResponse');
        const rawTextDiv = document.getElementById('suiteRawText');
        if (rawResponseDiv && rawTextDiv) {
            if (item.rawResponse) {
                rawTextDiv.textContent = item.rawResponse;
                rawResponseDiv.style.display = 'block';
                if (item.id && window.__suiteRawResponseByHistory) window.__suiteRawResponseByHistory.set(String(item.id), item.rawResponse);
            } else {
                rawTextDiv.textContent = '';
                rawResponseDiv.style.display = 'none';
            }
        }

        if (typeof window.__suiteRestoreFilesFromHistory === 'function') {
            await window.__suiteRestoreFilesFromHistory(item);
            if (applyToken !== suiteHistoryApplyToken) return;
        }

        if (typeof window.buildSlots === 'function') {
            window.buildSlots();
        } else {
            const buildBtn = document.getElementById('suiteBuildBtn');
            if (buildBtn) buildBtn.click();
        }
        if (applyToken !== suiteHistoryApplyToken) return;

        const cards = await waitCards(count);
        if (applyToken !== suiteHistoryApplyToken) return;
        let grantedArchiveDirectoryHandle = null;
        if (item.archiveStatus === 'archived' && suiteArchiveDirectoryHandle) {
            let permission = await querySuiteArchiveDirectoryPermission(suiteArchiveDirectoryHandle);
            if (permission !== 'granted') {
                permission = await requestSuiteArchiveDirectoryPermission(suiteArchiveDirectoryHandle);
            }
            if (permission === 'granted') {
                grantedArchiveDirectoryHandle = suiteArchiveDirectoryHandle;
            } else {
                debugWarn('归档目录未授权，无法读取本地归档图片:', {
                    permission,
                    archiveCode: item.archiveCode || '',
                    archiveFolderName: item.archiveFolderName || ''
                });
            }
        }
        let localArchiveMissCount = 0;
        for (let idx = 0; idx < cards.length; idx++) {
            const card = cards[idx];
            const imgObj = imageByIndex.get(idx + 1) || null;
            const failedObj = failedByIndex.get(idx + 1) || null;
            const slotKeyword = keywords[idx] || imgObj?.keyword || failedObj?.keyword || '';
            const textarea = card.querySelector('.suite-text-area');
            if (textarea) textarea.value = slotKeyword;

            let displayImageUrl = '';
            if (imgObj) {
                if (item.archiveStatus === 'archived') {
                    displayImageUrl = getSuiteArchiveCachedImageUrl(imgObj);
                    if (!displayImageUrl) {
                        displayImageUrl = await getSuiteArchiveSavedFileUrl(item, imgObj, false, grantedArchiveDirectoryHandle);
                    }
                    if (!displayImageUrl) localArchiveMissCount++;
                } else {
                    displayImageUrl = imgObj.imageUrl || '';
                }
            }

            if (imgObj && displayImageUrl) {
                setCardImage(card, displayImageUrl, '\u5361\u69fd ' + (idx + 1) + ' \u56fe\u7247');
                // 显示尺寸：优先用已存的 actualSize，否则从 img 元素读
                const metaEl = card.querySelector('.suite-meta');
                if (metaEl) {
                    if (imgObj.actualSize) {
                        metaEl.textContent = imgObj.actualSize;
                    } else {
                        const domImg = card.querySelector('.suite-image-slot img');
                        if (domImg) {
                            const resolveSize = () => {
                                if (domImg.naturalWidth) metaEl.textContent = `${domImg.naturalWidth} x ${domImg.naturalHeight}`;
                            };
                            if (domImg.complete) resolveSize();
                            else domImg.onload = resolveSize;
                        }
                    }
                }
            } else if (failedObj) {
                renderSuiteFailedSlot(card, failedObj.error);
            }

            // 优先显示图片：如果有图片数据，默认显示图片视图
            const hasImage = !!displayImageUrl;
            if (hasImage || failedObj) {
                setCardMode(card, 'image');
            } else {
                setCardMode(card, 'text');
            }
        }
        if (item.archiveStatus === 'archived' && localArchiveMissCount > 0) {
            debugWarn('归档记录未能从本地缓存/文件恢复全部图片:', {
                archiveCode: item.archiveCode || '',
                archiveFolderName: item.archiveFolderName || '',
                missCount: localArchiveMissCount,
                hasDirectoryHandle: !!suiteArchiveDirectoryHandle
            });
            showToast('归档图片未能从本地文件恢复，请确认归档目录授权正确', 'warning');
        }

        const hint = document.getElementById('suiteHint');
        const statusBar = document.getElementById('suiteStatusBar');
        if (hint) {
            // 如果 suiteStatusBar 正在显示运行状态，不覆盖 hint（避免覆盖生成提示）
            if (statusBar && statusBar.style.display !== 'none') {
                // 不设置 hint，保留运行状态提示
            } else {
                hint.textContent = showImages
                    ? '\u5df2\u663e\u793a\u5386\u53f2\u5957\u56fe\u7ed3\u679c\uff08' + images.length + ' \u5f20\uff09'
                    : '\u5df2\u590d\u7528\u5386\u53f2\u5957\u56fe\u5185\u5bb9\uff08' + count + ' \u4e2a\u5361\u69fd\uff09';
            }
            if (typeof window.__suiteRenderRunningStatus === 'function') {
                window.__suiteRenderRunningStatus();
            }
        }

        const drawer = document.getElementById('historyDrawer');
        const overlay = document.getElementById('drawerOverlay');
        if (drawer) drawer.classList.remove('open');
        if (overlay) overlay.classList.remove('open');

        notify(showImages
            ? '\u5df2\u663e\u793a\u8be5\u6b21\u5957\u56fe\u8bb0\u5f55'
            : '\u5df2\u590d\u7528\u8be5\u6b21\u5957\u56fe\u8bb0\u5f55');
    }

    window.reuseHistoryItemById = applySuiteHistory;

    window.restoreSuiteFromHistory = function(itemId) {
        applySuiteHistory(itemId, true);
    };
})();