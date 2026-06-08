const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 默认配置
let config = {
    port: 3005,
    banana_token: "",
    modelscope_token: "",
    chat_api_base: "",
    storage_path: "" // 新增：用户自定义落盘物理路径
};

// 读取或创建配置文件
if (fs.existsSync(CONFIG_PATH)) {
    try {
        const fileData = fs.readFileSync(CONFIG_PATH, 'utf8');
        config = { ...config, ...JSON.parse(fileData) };
    } catch (e) {
        console.error('⚠️ 读取 config.json 失败，使用默认配置:', e);
    }
} else {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8');
    console.log('📝 已在本地自动为您生成空配置文件: config.json');
}

// 动态解析物理落盘的总目录，若为空则默认存放在 Loirs 同级的 Loirs_Data 目录下
function getStorageRoot() {
    if (config.storage_path && config.storage_path.trim()) {
        return path.resolve(config.storage_path.trim());
    }
    return path.resolve(path.join(__dirname, '..', 'Loirs_Data'));
}

// 确保本地物理磁盘输出文件夹及 常规/套图/对话 三大子目录存在
function ensureStorageDirs() {
    const root = getStorageRoot();
    const output = path.join(root, 'output');
    const single = path.join(output, '常规');
    const suite = path.join(output, '套图');
    const chat = path.join(output, '对话');
    
    [root, output, single, suite, chat].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// 全局辅助函数：将图片（Base64 编码数据或远程 HTTP/HTTPS URL）保存到指定的物理磁盘文件路径下
async function saveImageToDisk(src, destPath) {
    if (!src || typeof src !== 'string') return false;
    
    try {
        if (src.startsWith('data:image/')) {
            const base64Data = src.replace(/^data:image\/\w+;base64,/, "");
            const buffer = Buffer.from(base64Data, 'base64');
            fs.writeFileSync(destPath, buffer);
            return true;
        } else if (src.startsWith('http://') || src.startsWith('https://')) {
            const response = await fetch(src);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            fs.writeFileSync(destPath, buffer);
            return true;
        }
    } catch (e) {
        console.error(`❌ 物理写盘失败，来源 URL/Base64 "${src.substring(0, 100)}..."，目标路径 "${destPath}":`, e);
    }
    return false;
}

// 获取历史数据库 history.json 文件的物理路径
function getHistoryPath() {
    return path.join(getStorageRoot(), 'history.json');
}

// 磁盘轻量 JSON 数据库读取
function getHistory() {
    ensureStorageDirs();
    const historyPath = getHistoryPath();
    if (fs.existsSync(historyPath)) {
        try {
            return JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        } catch (e) {
            console.error('⚠️ 读取 history.json 失败:', e);
            return [];
        }
    }
    return [];
}

// 磁盘轻量 JSON 数据库写入
function saveHistory(history) {
    ensureStorageDirs();
    fs.writeFileSync(getHistoryPath(), JSON.stringify(history, null, 4), 'utf8');
}

// 获取用户映射数据库 users.json 的物理路径
function getUsersPath() {
    return path.join(getStorageRoot(), 'users.json');
}

// 磁盘轻量用户数据读取
function getUsers() {
    ensureStorageDirs();
    const usersPath = getUsersPath();
    if (fs.existsSync(usersPath)) {
        try {
            return JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        } catch (e) {
            console.error('⚠️ 读取 users.json 失败:', e);
            return {};
        }
    }
    return {};
}

// 磁盘轻量用户数据写入
function saveUsers(users) {
    ensureStorageDirs();
    try {
        fs.writeFileSync(getUsersPath(), JSON.stringify(users, null, 4), 'utf8');
        return true;
    } catch (e) {
        console.error('⚠️ 写入 users.json 失败:', e);
        return false;
    }
}

// 判定当前请求是否来源于本机 (Localhost / Loopback)
function isLocalRequest(req) {
    const remoteAddress = req.socket.remoteAddress;
    return remoteAddress === '127.0.0.1' || 
           remoteAddress === '::1' || 
           remoteAddress === '::ffff:127.0.0.1';
}

// 深度过滤 Windows/Linux 文件系统禁用字符，让文件夹名字安全无暇
function sanitizeFolderName(name) {
    if (!name || !name.trim()) return '未命名对话';
    // 1. 强力清除任何看不见的控制字符、换行符 (\r, \n) 和制表符 (\t)
    let sanitized = name.trim().replace(/[\r\n\t\x00-\x1F\x7F]/g, '');
    // 2. 替换中英文 Windows 危险和禁用标点符号（包括全角/半角冒号、问号、斜杠、双引号、尖括号等）为下划线
    sanitized = sanitized.replace(/[\\\/:\*\?"<>\|：？＊“”（）《》｜\s]+/g, '_');
    // 3. 去掉可能导致 Windows Explorer 报错打不开的头部或尾部下划线、空格、句号等
    sanitized = sanitized.replace(/^_+|_+$/g, '').replace(/^\.+|\.+$/g, '').trim();
    if (!sanitized) return '未命名对话';
    if (sanitized.length > 100) {
        sanitized = sanitized.substring(0, 100).trim().replace(/_+$/g, '');
    }
    return sanitized;
}

// 获取目录下当前的自增文件编号（例如目录下有 5 张 png，下一张自动编为 0006）
function getNextFileNumber(dirPath) {
    try {
        if (!fs.existsSync(dirPath)) return '0001';
        const files = fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith('.png'));
        const nextNum = files.length + 1;
        return String(nextNum).padStart(4, '0');
    } catch (e) {
        return '0001';
    }
}

// 格式化生成时间，格式 YYYYMMDD_HHMMSS
function formatTimestamp(ts) {
    const d = ts ? new Date(ts) : new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

// 常见静态文件媒体类型
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// 静态文件分发服务
function serveStaticFile(req, res, filePath) {
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
        }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fs.statSync(filePath).size,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
    // 跨域支持 (CORS) 方便局域网同事访问
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // 0.1 API: 嗅探本地服务器运行状态并返回当前物理路径
    if (pathname === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            status: "ok",
            mode: "server",
            storagePath: getStorageRoot(),
            isLocal: isLocalRequest(req)
        }));
        return;
    }

    // 0.15 API: 用户免密登记/改名，进行强校验与重名检测
    if (pathname === '/api/register-user' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const clientId = data.clientId ? data.clientId.trim() : '';
                const username = data.username ? data.username.trim() : '';

                if (!clientId) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: '缺少设备指纹 ClientId' }));
                    return;
                }

                if (!username) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: '笔名不能为空' }));
                    return;
                }

                // 1. 验证长度 (2-10 字符)
                if (username.length < 2 || username.length > 10) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: '笔名长度必须在 2 到 10 个字之间' }));
                    return;
                }

                // 2. 拒绝纯数字
                if (/^\d+$/.test(username)) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: '笔名不能是纯数字，请换用有辨识度的名字' }));
                    return;
                }

                const users = getUsers();

                // 3. 检查重名 (必须是不同的 clientId)
                const isDuplicate = Object.entries(users).some(([existingId, existingName]) => {
                    return existingId !== clientId && existingName.toLowerCase() === username.toLowerCase();
                });

                if (isDuplicate) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: `笔名【${username}】已被其他同事占用，请换个名字哦` }));
                    return;
                }

                // 保存/更新映射
                users[clientId] = username;
                saveUsers(users);

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, clientId, username }));
            } catch (e) {
                console.error('❌ 用户登记失败:', e);
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // 0.16 API: 获取所有已注册的用户列表 (管理员专属)
    if (pathname === '/api/get-users' && req.method === 'GET') {
        const users = getUsers();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(users));
        return;
    }

    // 0.2 API: 获取物理磁盘历史数据库记录 (支持多用户隔离与管理员过滤)
    if (pathname === '/api/history' && req.method === 'GET') {
        const isLocal = isLocalRequest(req);
        const reqClientId = parsedUrl.query.clientId || '';
        const filterClientId = parsedUrl.query.filterClientId || ''; // 管理员下拉选择过滤
        
        let history = getHistory();
        
        if (isLocal) {
            // 本机超级管理员：支持按 clientId 筛选
            if (filterClientId && filterClientId !== 'all') {
                history = history.filter(h => h.clientId === filterClientId);
            }
            // 如果 filterClientId 为空或 'all'，则展示所有大杂烩记录
        } else {
            // 同事/局域网端：严格锁定展示自己的记录
            if (reqClientId) {
                history = history.filter(h => h.clientId === reqClientId);
            } else {
                history = []; // 没有携带设备指纹一律展示为空
            }
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(history));
        return;
    }

    // 0.3 API: 物理存图与智能命名引擎
    if (pathname === '/api/save-image' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            try {
                const record = JSON.parse(body);
                if (!record.id) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing id' }));
                    return;
                }
                
                // 安全注入多用户标识
                const isLocal = isLocalRequest(req);
                if (isLocal) {
                    record.clientId = record.clientId || 'local_admin';
                    record.username = record.username || '本机管理员';
                } else {
                    // 同事端必须要设备指纹，如果没有，尝试在服务端通过 users.json 查取
                    record.clientId = record.clientId || '';
                    if (record.clientId) {
                        const users = getUsers();
                        record.username = users[record.clientId] || '局域网用户';
                    } else {
                        record.clientId = 'unknown';
                        record.username = '未知设备';
                    }
                }
                
                // 确定套图和普通模式
                const isSuiteMode = record.mode === 'suite' || record.type === 'suite';
                const root = getStorageRoot();
                
                // 1. 如果是套图模式
                if (isSuiteMode) {
                    const destDir = path.join(root, 'output', '套图');
                    if (!fs.existsSync(destDir)) {
                        fs.mkdirSync(destDir, { recursive: true });
                    }
                    
                    // 确定套图文件夹名称（支持断点续存，保持在同一套图任务目录下）
                    let suiteFolderName = record.localFolderName;
                    if (!suiteFolderName) {
                        const timeStr = formatTimestamp(record.timestamp);
                        const seqNum = getNextFileNumber(destDir);
                        suiteFolderName = `${seqNum}_${timeStr}`;
                        record.localFolderName = suiteFolderName;
                    }
                    
                    const taskDir = path.join(destDir, suiteFolderName);
                    if (!fs.existsSync(taskDir)) {
                        fs.mkdirSync(taskDir, { recursive: true });
                    }
                    
                    // 保存生成的插槽子图片 (支持 Base64 或 http/https 网络地址)
                    if (Array.isArray(record.images) && record.images.length > 0) {
                        for (const img of record.images) {
                            const imgData = img.imageUrl || img.url;
                            if (img && imgData && typeof imgData === 'string' && (imgData.startsWith('data:image/') || imgData.startsWith('http'))) {
                                const imgFilename = `slot${img.index || 1}.png`;
                                const imgPath = path.join(taskDir, imgFilename);
                                
                                const success = await saveImageToDisk(imgData, imgPath);
                                if (success) {
                                    // 更新相对路径 (URL 进行编码以防乱码)
                                    const localRelativePath = `/output/%E5%A5%97%E5%9B%BE/${encodeURIComponent(suiteFolderName)}/${imgFilename}`;
                                    img.imageUrl = localRelativePath;
                                    img.url = localRelativePath;
                                    if (img.thumbnail) {
                                        img.thumbnail = localRelativePath;
                                    }
                                }
                            }
                        }
                    }
                    
                    // 保存参考图片 (如果有的话)
                    if (Array.isArray(record.fileData) && record.fileData.length > 0) {
                        for (let index = 0; index < record.fileData.length; index++) {
                            const file = record.fileData[index];
                            if (file && file.data && typeof file.data === 'string' && file.data.startsWith('data:image/')) {
                                const refFilename = `ref${index + 1}.png`;
                                const refPath = path.join(taskDir, refFilename);
                                
                                const success = await saveImageToDisk(file.data, refPath);
                                if (success) {
                                    // 清洗掉 Base64 替换为精简物理 URL，防止 history.json 爆满
                                    file.data = `/output/%E5%A5%97%E5%9B%BE/${encodeURIComponent(suiteFolderName)}/${refFilename}`;
                                }
                            }
                        }
                    }
                    
                    // 设置封面图
                    const firstValidImg = record.images && record.images.find(img => (img.imageUrl || img.url) && !(img.imageUrl || img.url).startsWith('data:image/') && !(img.imageUrl || img.url).startsWith('http'));
                    if (firstValidImg) {
                        const firstUrl = firstValidImg.imageUrl || firstValidImg.url;
                        record.firstImage = firstUrl;
                        record.thumbnail = firstUrl;
                        record.url = firstUrl;
                    }
                }
                
                // 2. 如果是常规模式或对话模式
                else {
                    const mode = record.mode || 'single';
                    let destDir = path.join(root, 'output', '常规');
                    let modeFolder = '常规';
                    
                    if (mode === 'chat') {
                        const chatFolderName = sanitizeFolderName(record.chatName);
                        destDir = path.join(root, 'output', '对话', chatFolderName);
                        modeFolder = '对话';
                    }
                    
                    // 确保目标子目录存在
                    if (!fs.existsSync(destDir)) {
                        fs.mkdirSync(destDir, { recursive: true });
                    }
                    
                    // 计算自增编号和时间，生成最终文件名
                    const seqNum = getNextFileNumber(destDir);
                    const timeStr = formatTimestamp(record.timestamp);
                    const imgFilename = `${seqNum}_${timeStr}.png`;
                    const imgPath = path.join(destDir, imgFilename);
                    
                    let browserUrl = '';
                    
                    // 2a. 保存生成的主图
                    if (record.imageData && typeof record.imageData === 'string' && (record.imageData.startsWith('data:image/') || record.imageData.startsWith('http'))) {
                        const success = await saveImageToDisk(record.imageData, imgPath);
                        if (success) {
                            if (mode === 'chat') {
                                const chatFolderName = sanitizeFolderName(record.chatName);
                                browserUrl = `/output/对话/${encodeURIComponent(chatFolderName)}/${imgFilename}`;
                            } else {
                                browserUrl = `/output/${encodeURIComponent(modeFolder)}/${imgFilename}`;
                            }
                        }
                    }
                    
                    // 2b. 保存参考图
                    if (Array.isArray(record.fileData) && record.fileData.length > 0) {
                        for (let index = 0; index < record.fileData.length; index++) {
                            const file = record.fileData[index];
                            if (file && file.data && typeof file.data === 'string' && file.data.startsWith('data:image/')) {
                                const refFilename = `${seqNum}_${timeStr}_ref${index + 1}.png`;
                                const refPath = path.join(destDir, refFilename);
                                
                                const success = await saveImageToDisk(file.data, refPath);
                                if (success) {
                                    if (mode === 'chat') {
                                        const chatFolderName = sanitizeFolderName(record.chatName);
                                        file.data = `/output/对话/${encodeURIComponent(chatFolderName)}/${refFilename}`;
                                    } else {
                                        file.data = `/output/常规/${refFilename}`;
                                    }
                                }
                            }
                        }
                    }
                    
                    // 剔除高内存消耗的 imageData，替换为轻量级 url
                    delete record.imageData;
                    if (browserUrl) {
                        record.url = browserUrl;
                        record.thumbnail = browserUrl;
                    }
                }
                
                // 将记录写入历史数据库 history.json
                const history = getHistory();
                const existingIdx = history.findIndex(h => h.id === record.id);
                let finalRecord = record;
                if (existingIdx !== -1) {
                    // 合并现有记录与更新（支持增量更新）
                    history[existingIdx] = { ...history[existingIdx], ...record };
                    finalRecord = history[existingIdx];
                } else {
                    history.unshift(record); // 最新生成的排在最前面
                }
                saveHistory(history);
                
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, url: finalRecord.url, record: finalRecord }));
            } catch (e) {
                console.error('❌ 保存本地图片失败:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 0.4 API: 动态修改存储路径 (无需重启)
    if (pathname === '/api/storage-path' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                let newPath = data.path ? data.path.trim() : '';
                
                // 更新内存中的配置
                config.storage_path = newPath;
                
                // 测试在该目录下创建子目录以确保可写
                ensureStorageDirs();
                
                // 永久保存至 config.json
                fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8');
                
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    success: true,
                    storagePath: getStorageRoot()
                }));
            } catch (e) {
                console.error('❌ 更改存储路径失败:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 0.5 API: 删除/清空历史记录并智能同步物理删除磁盘图片 (带有严格多用户权限检验)
    if (pathname === '/api/history' && req.method === 'DELETE') {
        const isLocal = isLocalRequest(req);
        const reqClientId = parsedUrl.query.clientId || '';
        const recordId = parsedUrl.query.id;
        let history = getHistory();
        
        if (recordId) {
            // 单个删除
            const record = history.find(h => String(h.id) === String(recordId));
            if (record) {
                // 权限校验：如果是局域网同事，只能删除属于自己 clientId 的记录
                if (!isLocal && record.clientId !== reqClientId) {
                    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: '权限不足：您不能删除其他同事的作品' }));
                    return;
                }
                
                // 执行物理文件清理 (如果是套图，清理整个套图目录)
                // 1. 常规模式物理文件清理
                let fileRelPath = record.url;
                if (fileRelPath && fileRelPath.startsWith('/output/')) {
                    const relativePath = decodeURIComponent(fileRelPath.substring(8));
                    const safeRelativePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
                    const filePath = path.join(getStorageRoot(), 'output', safeRelativePath);
                    if (fs.existsSync(filePath)) {
                        try {
                            const stat = fs.statSync(filePath);
                            if (stat.isFile()) {
                                fs.unlinkSync(filePath);
                            }
                        } catch (e) {
                            console.error('⚠️ 删除本地物理图片失败:', filePath, e);
                        }
                    }
                }
                
                // 2. 套图目录递归物理删除
                if ((record.mode === 'suite' || record.type === 'suite') && record.localFolderName) {
                    const suiteDir = path.join(getStorageRoot(), 'output', '套图', record.localFolderName);
                    if (fs.existsSync(suiteDir)) {
                        try {
                            fs.rmSync(suiteDir, { recursive: true, force: true });
                        } catch (e) {
                            console.error('⚠️ 删除套图物理文件夹失败:', suiteDir, e);
                        }
                    }
                }
                
                // 3. 关联参考图物理删除
                if (Array.isArray(record.fileData)) {
                    record.fileData.forEach(file => {
                        if (file && file.data && file.data.startsWith('/output/')) {
                            const relPath = decodeURIComponent(file.data.substring(8));
                            const safeRel = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
                            const refPath = path.join(getStorageRoot(), 'output', safeRel);
                            if (fs.existsSync(refPath)) {
                                try { fs.unlinkSync(refPath); } catch (_) {}
                            }
                        }
                    });
                }
                
                // 从数据库中剔除
                history = history.filter(h => String(h.id) !== String(recordId));
                saveHistory(history);
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true }));
        } else {
            // 批量/全盘清理
            if (isLocal) {
                // 本机超级管理员：彻底清空所有人历史 + 所有物理文件
                saveHistory([]);
                const root = getStorageRoot();
                const subdirs = [
                    path.join(root, 'output', '常规'),
                    path.join(root, 'output', '套图'),
                    path.join(root, 'output', '对话')
                ];
                
                subdirs.forEach(dir => {
                    if (fs.existsSync(dir)) {
                        try {
                            const items = fs.readdirSync(dir);
                            items.forEach(item => {
                                const itemPath = path.join(dir, item);
                                const stat = fs.statSync(itemPath);
                                if (stat.isDirectory()) {
                                    fs.rmSync(itemPath, { recursive: true, force: true });
                                } else {
                                    fs.unlinkSync(itemPath);
                                }
                            });
                        } catch (e) {
                            console.error('⚠️ 清理存储子目录失败:', dir, e);
                        }
                    }
                });
            } else {
                // 局域网同事：仅清空属于自己 clientId 的历史记录 + 对应物理文件
                if (!reqClientId) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: '缺少设备指纹' }));
                    return;
                }
                
                const myRecords = history.filter(h => h.clientId === reqClientId);
                myRecords.forEach(record => {
                    // 删除主文件
                    let fileRelPath = record.url;
                    if (fileRelPath && fileRelPath.startsWith('/output/')) {
                        const relativePath = decodeURIComponent(fileRelPath.substring(8));
                        const safeRelativePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
                        const filePath = path.join(getStorageRoot(), 'output', safeRelativePath);
                        if (fs.existsSync(filePath)) {
                            try { fs.unlinkSync(filePath); } catch (_) {}
                        }
                    }
                    // 删除套图文件夹
                    if ((record.mode === 'suite' || record.type === 'suite') && record.localFolderName) {
                        const suiteDir = path.join(getStorageRoot(), 'output', '套图', record.localFolderName);
                        if (fs.existsSync(suiteDir)) {
                            try { fs.rmSync(suiteDir, { recursive: true, force: true }); } catch (_) {}
                        }
                    }
                    // 删除参考图
                    if (Array.isArray(record.fileData)) {
                        record.fileData.forEach(file => {
                            if (file && file.data && file.data.startsWith('/output/')) {
                                const relPath = decodeURIComponent(file.data.substring(8));
                                const safeRel = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
                                const refPath = path.join(getStorageRoot(), 'output', safeRel);
                                if (fs.existsSync(refPath)) {
                                    try { fs.unlinkSync(refPath); } catch (_) {}
                                }
                            }
                        });
                    }
                });
                
                // 过滤掉当前用户的记录，保留其他人的记录
                history = history.filter(h => h.clientId !== reqClientId);
                saveHistory(history);
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true }));
        }
        return;
    }

    // 1. API: 获取配置状态（前端用来隐藏/禁用密码框）
    if (pathname === '/api/config' && req.method === 'GET') {
        const hasBanana = !!(config.banana_token && config.banana_token.trim());
        const hasModelScope = !!(config.modelscope_token && config.modelscope_token.trim());
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            hasBananaToken: hasBanana,
            hasModelScopeToken: hasModelScope
        }));
        return;
    }

    // 2. API: 核心安全的 API 代理转发 (SSE 流式传输支持)
    if (pathname === '/api/proxy') {
        const targetUrlStr = req.headers['x-target-url'];
        if (!targetUrlStr) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Missing X-Target-URL header');
            return;
        }

        try {
            const targetUrl = new URL(targetUrlStr);
            const isHttps = targetUrl.protocol === 'https:';
            const requestModule = isHttps ? https : http;

            // 复制并过滤请求头，防止引起证书或压缩混淆问题
            const headers = { ...req.headers };
            delete headers['host'];
            delete headers['x-target-url'];
            delete headers['connection'];
            delete headers['accept-encoding']; // 禁用 gzip 以方便透传 stream

            // 注入托管的后端 API Key
            const targetHost = targetUrl.hostname;
            if (targetHost.includes('modelscope.cn')) {
                if (config.modelscope_token && config.modelscope_token.trim()) {
                    headers['authorization'] = `Bearer ${config.modelscope_token.trim()}`;
                }
            } else {
                if (config.banana_token && config.banana_token.trim()) {
                    headers['authorization'] = `Bearer ${config.banana_token.trim()}`;
                }
            }

            const proxyReqOptions = {
                method: req.method,
                hostname: targetUrl.hostname,
                port: targetUrl.port || (isHttps ? 443 : 80),
                path: targetUrl.pathname + targetUrl.search,
                headers: headers,
                rejectUnauthorized: false // 忽略自签名证书，提高局域网连通率
            };

            const proxyReq = requestModule.request(proxyReqOptions, (proxyRes) => {
                // 写入目标服务器的状态码与响应头
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                // 实时流式流向客户端 (非常关键，保留了 SSE 正在思考的打字机流效果)
                proxyRes.pipe(res);
            });

            proxyReq.on('error', (err) => {
                console.error('❌ Proxy Request Error:', err);
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Proxy Error: ${err.message}`);
            });

            // 将前端的 POST body 请求体数据流直接转发给目标 API 
            req.pipe(proxyReq);
        } catch (e) {
            console.error('❌ Invalid Target URL:', targetUrlStr, e);
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Invalid X-Target-URL: ${e.message}`);
        }
        return;
    }

    // 3. 静态资源和本地磁盘物理图片转发
    const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    
    // 拦截本地磁盘物理图片资源请求，映射回 Loirs_Data/output/...
    if (pathname.startsWith('/output/')) {
        let relativePath = pathname.substring(8);
        try {
            relativePath = decodeURIComponent(relativePath);
        } catch (e) {
            console.error('⚠️ [Static] decodeURIComponent 解析相对路径失败:', relativePath, e);
        }
        const safeRelativePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
        const filePath = path.join(getStorageRoot(), 'output', safeRelativePath);
        
        console.log(`📁 [Static Forward]: URL ${pathname} -> 映射物理文件: ${filePath}`);
        
        serveStaticFile(req, res, filePath);
        return;
    }
    
    // 如果请求的是首页，并且已经运行了 build.js 进行了混淆打包，则优先返回无注释、已压缩的安全版本
    if (safePath === '/' || safePath === '\\' || safePath === 'index.html') {
        const bundledPath = path.join(__dirname, 'dist', 'index_bundled.html');
        if (fs.existsSync(bundledPath)) {
            serveStaticFile(req, res, bundledPath);
            return;
        }
    }
    
    const filePath = path.join(PUBLIC_DIR, safePath);
    serveStaticFile(req, res, filePath);
});

// 获取本机局域网 IP 方便分享给同事
function getLocalIP() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const PORT = config.port || 3005;
server.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    console.log(`================================================================`);
    console.log(`🔒 Loris 局域网安全托管后端服务启动成功！`);
    console.log(`----------------------------------------------------------------`);
    console.log(`🌐 局域网内同事电脑访问： http://${localIP}:${PORT}`);
    console.log(`🏠 您本人的电脑本地访问： http://localhost:${PORT}`);
    console.log(`----------------------------------------------------------------`);
    console.log(`💡 提示：在同目录下的 config.json 中填入 Banana / 魔塔 API 密钥，`);
    console.log(`   同事在网页里将【无法窥视】或【拷贝】您的密钥，彻底防盗刷。`);
    console.log(`================================================================`);
});
